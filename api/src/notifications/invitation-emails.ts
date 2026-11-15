import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../config/env.validation';
import { rowsOf } from '../database/sql';
import { MetricsService } from '../metrics/metrics.service';
import { UNSAFE_TEXT } from '../users/display-name';
import { EmailLinks } from './email-links';
import { EMAIL_ELIGIBLE } from './email-eligibility';
import { EMAIL_TYPES } from './notification-types';
import { EMAIL_SENDER } from './providers/email-sender';
import type { EmailMessage, EmailSender } from './providers/email-sender';

interface Claimed {
  id: string;
  user_id: string;
  title: string;
  url: string | null;
  expires_at: Date;
  email_attempts: number;
}

export interface EmailItem {
  title: string;
  url: string | null;
  expiresAt: Date;
}

export const PEOPLE_PER_RUN = 100;
// A refused email is tried again 5, 10, 20 and 40 minutes after each attempt
// (email_at is when the last one was claimed): five attempts over about 75
// minutes of provider trouble, then it is given up on.
const MAX_ATTEMPTS = 5;
const RETRY_DUE = `(n.email_attempts = 0
  OR n.email_at <= now() - interval '5 minutes' * power(2, n.email_attempts - 1))`;
// A claim not settled within this long belongs to a worker that died
// mid-send: it goes back in the queue. As with push, a rare duplicate email
// beats a lost invitation (ADR 0003).
const CLAIM_LEASE = '10 minutes';

// Every statement below: due an email (EMAIL_ELIGIBLE), and not waiting out
// a retry delay.
const ELIGIBLE = `${EMAIL_ELIGIBLE} AND ${RETRY_DUE}`;

// The second channel, for invitees push can't reach (see ADR 0006). One
// email per person per day at most: everything waiting for them goes in it.
// Only the invitation, never a "come back" message: that would make it
// marketing, which needs consent. The opt-out link is in every email.
@Injectable()
export class InvitationEmailer {
  private readonly logger = new Logger(InvitationEmailer.name);

  constructor(
    private readonly db: DataSource,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly links: EmailLinks,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly metrics: MetricsService,
  ) {}

  // One pass. Returns how many people it emailed or tried to, so the worker
  // can go again straight away while a pass comes back full.
  async runOnce(): Promise<number> {
    await this.reclaimStale();
    const args = [
      EMAIL_TYPES,
      this.config.get('EMAIL_AFTER_SECONDS', { infer: true }),
      this.config.get('INVITE_TTL_DAYS', { infer: true }),
    ];
    const { claimed, emails, optedOut } = await this.db.transaction(
      async (m) => {
        const people = rowsOf<{ user_id: string }>(
          await m.query(
            // Skips people already emailed today, so they can't crowd out
            // everyone else; opted-out people still need recording.
            `SELECT DISTINCT n.user_id
             FROM notifications n, invitations i, users u
             WHERE ${ELIGIBLE} AND u.id = n.user_id
               AND (NOT u.invitation_emails
                    OR u.last_invitation_email_at IS NULL
                    OR u.last_invitation_email_at <= now() - interval '24 hours')
             LIMIT ${PEOPLE_PER_RUN}`,
            args,
          ),
        );
        const ids = people.map((p) => p.user_id);
        if (ids.length === 0) return { claimed: [], emails: {}, optedOut: 0 };

        // Turned invitation emails off: record that push couldn't reach
        // them, and send nothing.
        const optedOut = rowsOf(
          await m.query(
            `UPDATE notifications n SET email_status = 'opted_out', updated_at = now()
             FROM invitations i, users u
             WHERE ${ELIGIBLE} AND n.user_id = ANY($4)
               AND u.id = n.user_id AND NOT u.invitation_emails
             RETURNING n.id`,
            [...args, ids],
          ),
        ).length;

        // Claim each remaining person for today. The UPDATE re-checks its
        // condition against the latest version of the row, so two workers
        // can't both claim one person: this is what holds it to one a day.
        const users = rowsOf<{ id: string; email: string }>(
          await m.query(
            `UPDATE users SET last_invitation_email_at = now()
             WHERE id = ANY($1) AND invitation_emails
               AND (last_invitation_email_at IS NULL
                    OR last_invitation_email_at <= now() - interval '24 hours')
             RETURNING id, email`,
            [ids],
          ),
        );
        if (users.length === 0) return { claimed: [], emails: {}, optedOut };

        // Everything waiting for those people goes in their one email.
        const claimed = rowsOf<Claimed>(
          await m.query(
            `UPDATE notifications n
             SET email_status = 'pending', email_at = now(),
                 email_attempts = n.email_attempts + 1, updated_at = now()
             FROM invitations i
             WHERE ${ELIGIBLE} AND n.user_id = ANY($4)
             RETURNING n.id, n.user_id, n.title, n.data->>'url' AS url,
                       i.expires_at, n.email_attempts`,
            [...args, users.map((u) => u.id)],
          ),
        );
        // Nothing of someone's was left to claim (answered, seen or retried
        // since they were picked): give their day back. Their row stays
        // locked until this transaction commits, so no other worker ever saw
        // the day taken, and none can claim it in between.
        const claimedFor = new Set(claimed.map((c) => c.user_id));
        const unused = users.filter((u) => !claimedFor.has(u.id));
        if (unused.length)
          await m.query(
            `UPDATE users SET last_invitation_email_at = NULL WHERE id = ANY($1)`,
            [unused.map((u) => u.id)],
          );
        const emails = Object.fromEntries(users.map((u) => [u.id, u.email]));
        return { claimed, emails, optedOut };
      },
    );
    if (optedOut)
      this.metrics.invitationEmails.labels('opted_out').inc(optedOut);
    if (claimed.length === 0) return 0;

    // Send outside the transaction: a slow provider must not hold locks.
    const byUser = new Map<string, Claimed[]>();
    for (const c of claimed)
      byUser.set(c.user_id, [...(byUser.get(c.user_id) ?? []), c]);

    const from = this.config.get('EMAIL_FROM', { infer: true });
    const sent: string[] = [];
    const retry: { id: string; error: string }[] = [];
    const failed: { id: string; error: string }[] = [];
    const refused: string[] = [];
    for (const [userId, items] of byUser) {
      try {
        await this.email.send({
          from,
          to: emails[userId],
          ...invitationEmail(
            items.map((c) => ({
              title: c.title,
              url: c.url,
              expiresAt: new Date(c.expires_at),
            })),
            this.links.unsubscribeUrl(userId),
          ),
        });
        sent.push(...items.map((c) => c.id));
      } catch (e) {
        const error = (e instanceof Error ? e.message : String(e)).slice(
          0,
          500,
        );
        refused.push(userId);
        // A provider hiccup: each invitation is tried again after a growing
        // wait (RETRY_DUE), up to MAX_ATTEMPTS in all, then given up on.
        for (const c of items)
          (c.email_attempts < MAX_ATTEMPTS ? retry : failed).push({
            id: c.id,
            error,
          });
      }
    }

    // Each outcome is recorded only while the row is still on this claim
    // (pending, same attempt): a worker that outlived the lease can't undo
    // the outcome of the worker that took the claim over, or free the day
    // that worker claimed.
    // The metrics count the rows each UPDATE changed, for the same reason.
    const attemptsOf = new Map(claimed.map((c) => [c.id, c.email_attempts]));
    const done = { sent: 0, retry: 0, failed: 0 };
    await this.db.transaction(async (m) => {
      if (sent.length)
        done.sent = rowsOf(
          await m.query(
            `UPDATE notifications n SET email_status = 'sent', email_error = NULL, updated_at = now()
             FROM unnest($1::uuid[], $2::int[]) AS c(id, attempts)
             WHERE n.id = c.id AND n.email_attempts = c.attempts AND n.email_status = 'pending'
             RETURNING n.id`,
            [sent, sent.map((id) => attemptsOf.get(id))],
          ),
        ).length;
      const settledRefused = new Set<string>();
      for (const [list, status, outcome] of [
        [retry, 'none', 'retry'],
        [failed, 'failed', 'failed'],
      ] as const) {
        if (!list.length) continue;
        const rows = rowsOf<{ user_id: string }>(
          await m.query(
            `UPDATE notifications n SET email_status = $4::notifications_email_status_enum,
               email_error = f.error,
               updated_at = now()
             FROM unnest($1::uuid[], $2::int[], $3::text[]) AS f(id, attempts, error)
             WHERE n.id = f.id AND n.email_attempts = f.attempts AND n.email_status = 'pending'
             RETURNING n.user_id`,
            [
              list.map((f) => f.id),
              list.map((f) => attemptsOf.get(f.id)),
              list.map((f) => f.error),
              status,
            ],
          ),
        );
        done[outcome] = rows.length;
        for (const r of rows) settledRefused.add(r.user_id);
      }
      // Nothing reached these people: release the day's claim, so a retry
      // or their next invitation doesn't wait 24 hours.
      if (settledRefused.size)
        await m.query(
          `UPDATE users SET last_invitation_email_at = NULL WHERE id = ANY($1)`,
          [[...settledRefused]],
        );
    });

    for (const [outcome, n] of Object.entries(done))
      if (n) this.metrics.invitationEmails.labels(outcome).inc(n);
    if (refused.length)
      this.logger.warn(
        JSON.stringify({
          msg: 'invitation email problems',
          retry: retry.length,
          failed: failed.length,
          error: (retry[0] ?? failed[0]).error,
        }),
      );
    return byUser.size;
  }

  // Claims a worker took and never settled (it died between claiming and
  // recording the outcome) go back in the queue, with the person's day.
  private async reclaimStale() {
    const rows = await this.db.transaction(async (m) => {
      const rows = rowsOf<{ user_id: string }>(
        await m.query(
          `UPDATE notifications SET email_status = 'none', updated_at = now()
           WHERE email_status = 'pending'
             AND email_at < now() - interval '${CLAIM_LEASE}'
           RETURNING user_id`,
        ),
      );
      if (rows.length)
        await m.query(
          `UPDATE users SET last_invitation_email_at = NULL WHERE id = ANY($1)`,
          [[...new Set(rows.map((r) => r.user_id))]],
        );
      return rows;
    });
    if (rows.length === 0) return;
    this.logger.warn(
      `Reclaimed ${rows.length} invitation emails from a stalled worker`,
    );
  }
}

// What the email says. Deliberately plain: who invited them, where to answer,
// when it expires, and why they're getting it. No message text and no photo,
// because inboxes get shared and previews show on lock screens; and nothing
// promotional, which would turn a service message into marketing.
export function invitationEmail(
  items: EmailItem[],
  unsubscribeUrl: string,
  now = new Date(),
): Omit<EmailMessage, 'to' | 'from'> {
  const expires = (d: Date) => {
    const days = Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
    return days <= 1 ? 'within a day' : `in ${days} days`;
  };
  const footer =
    `You're getting this email because Invites can't reach your phone with ` +
    `a notification. Stop these emails: ${unsubscribeUrl}`;
  const headers = {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  // Display names are the inviter's own text: no control characters (no
  // header tricks), no line or paragraph separators and nothing that hides
  // or reorders text reach the subject or the body (see display-name.ts).
  const unsafe = new RegExp(`${UNSAFE_TEXT.source}+`, 'gu');
  items = items.map((it) => ({
    ...it,
    title: it.title.replace(unsafe, ' ').trim(),
  }));

  if (items.length === 1) {
    const [it] = items;
    return {
      subject: it.title,
      text: [
        `${it.title} on Invites.`,
        '',
        `Open the invitation: ${it.url ?? 'open the Invites app'}`,
        `It expires ${expires(it.expiresAt)}.`,
        '',
        footer,
      ].join('\n'),
      headers,
    };
  }
  return {
    subject: `You have ${items.length} new invitations`,
    text: [
      `You have ${items.length} new invitations on Invites:`,
      '',
      ...items.map(
        (it) =>
          `- ${it.title}: ${it.url ?? 'open the Invites app'} (expires ${expires(it.expiresAt)})`,
      ),
      '',
      footer,
    ].join('\n'),
    headers,
  };
}
