import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type { AppConfig } from '../config/env.validation';
import { rowsOf } from '../database/sql';
import { Device } from '../devices/device.entity';
import { DevicesService } from '../devices/devices.service';
import { MetricsService } from '../metrics/metrics.service';
import { AckTokens } from './ack-tokens';
import { retryDelaySeconds } from './backoff';
import { NotificationType } from './notification-types';
import {
  DEVICE_NOT_REGISTERED,
  isRetryableProviderError,
  NOT_SENT,
  PUSH_SENDER,
} from './providers/push-sender';
import type {
  PushMessage,
  PushResult,
  PushSender,
} from './providers/push-sender';

interface Claimed {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  attempts: number;
  transport_failures: number;
  created_at: Date;
  withdrawn: boolean;
}

export const LEASE_SECONDS = 60;
// The sender's deadline, counted from the claim. ExpoPushSender starts no
// request that couldn't finish by then, so a batch is never still sending
// when its lease runs out and another worker claims the rows again; the 20 s
// left cover the writes that record the results.
export const SEND_SECONDS = 40;

// Claims due notifications from the outbox and pushes them.
//
// Safe to run on many workers at once: FOR UPDATE SKIP LOCKED hands each row
// to exactly one of them, and the others skip it instead of waiting. A worker
// that dies mid-batch leaves rows in 'sending' with an expired lease;
// reclaimStale() puts them back in the queue.
//
// Delivery is at-least-once. If a worker crashes after Expo accepted a
// message but before recording it, that message is sent again. A rare
// duplicate push is the price of never silently losing one.
//
// A result is recorded only while the row is still on this worker's claim:
// same attempt number, still 'sending'. A phone's ack or an in-app view that
// lands mid-send is kept (only sent_at is added), and a worker that outlived
// its lease can't overwrite the result of the worker that took the row over.
//
// Retries: a transport failure (network, timeout, Expo 429 or 5xx) gets
// PUSH_MAX_ATTEMPTS attempts, counted in transport_failures. A provider-side
// error (credentials, or Apple or Google rate-limiting us) says nothing about
// the message, so it doesn't use up attempts: it is retried, at most 30
// minutes apart, until the notification is PUSH_GIVE_UP_AFTER_HOURS old. A
// push left unsent at the send deadline never reached Expo: it goes back in
// the queue a few seconds later, also without using up an attempt.
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly db: DataSource,
    private readonly devices: DevicesService,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly metrics: MetricsService,
    private readonly ack: AckTokens,
  ) {}

  // One batch. Returns how many notifications it claimed, so the caller can
  // keep going while the outbox is full and rest when it's empty.
  async runOnce(): Promise<number> {
    const batchSize = this.config.get('DISPATCH_BATCH_SIZE', { infer: true });
    const claimedAt = Date.now();
    const claimed = rowsOf<Claimed>(
      await this.db.query(
        `WITH due AS (
           SELECT id FROM notifications
           WHERE status = 'pending' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE notifications n
         SET status = 'sending',
             attempts = n.attempts + 1,
             locked_until = now() + make_interval(secs => $2),
             updated_at = now()
         FROM due WHERE n.id = due.id
         RETURNING n.id, n.user_id, n.type, n.title, n.body, n.data, n.attempts,
           n.transport_failures, n.created_at,
           -- The inviter cancelled it, or it expired, while it waited.
           n.type = $3 AND EXISTS (
             SELECT 1 FROM invitations i
             WHERE i.id = (n.data->>'invitationId')::uuid
               AND (i.status <> 'pending' OR i.expires_at <= now())) AS withdrawn`,
        [batchSize, LEASE_SECONDS, NotificationType.InvitationReceived],
      ),
    );
    if (claimed.length === 0) return 0;
    const attemptsOf = new Map(claimed.map((n) => [n.id, n.attempts]));
    const withAttempts = (ids: string[]) => [
      ids,
      ids.map((id) => attemptsOf.get(id)),
    ];

    // Only phones that can show it: pushing to a phone with notifications off
    // succeeds at every layer and reaches no one.
    const devices = await this.devices.reachableFor([
      ...new Set(claimed.map((n) => n.user_id)),
    ]);
    const devicesByUser = groupBy(devices, (d) => d.userId);

    // One push message per (notification, device).
    const sends: { n: Claimed; device: Device; msg: PushMessage }[] = [];
    for (const n of claimed) {
      if (n.withdrawn) continue;
      for (const device of devicesByUser.get(n.user_id) ?? []) {
        sends.push({
          n,
          device,
          msg: {
            to: device.expoPushToken,
            title: n.title,
            body: n.body,
            data: {
              ...n.data,
              notificationId: n.id,
              type: n.type,
              // Lets the phone confirm delivery without a session.
              ackToken: this.ack.sign(n.id),
            },
          },
        });
      }
    }
    const results: PushResult[] = sends.length
      ? await this.push.send(
          sends.map((s) => s.msg),
          claimedAt + SEND_SECONDS * 1000,
        )
      : [];

    const resultsByNotification = new Map<string, PushResult[]>();
    sends.forEach((s, i) => {
      const list = resultsByNotification.get(s.n.id) ?? [];
      list.push(results[i]);
      resultsByNotification.set(s.n.id, list);
    });

    const maxAttempts = this.config.get('PUSH_MAX_ATTEMPTS', { infer: true });
    const giveUpMs =
      this.config.get('PUSH_GIVE_UP_AFTER_HOURS', { infer: true }) * 3_600_000;
    const sent: string[] = [];
    const unreachable: string[] = [];
    const failed: { id: string; failures: number; error: string }[] = [];
    const retry: {
      id: string;
      failures: number;
      delay: number;
      error: string;
    }[] = [];
    const withdrawn: string[] = [];

    for (const n of claimed) {
      const rs = resultsByNotification.get(n.id);
      if (n.withdrawn) {
        withdrawn.push(n.id);
      } else if (!rs) {
        unreachable.push(n.id);
      } else if (rs.some((r) => r.ok)) {
        sent.push(n.id);
      } else if (rs.every((r) => !r.ok && r.error === DEVICE_NOT_REGISTERED)) {
        unreachable.push(n.id);
      } else {
        const error = rs
          .map((r) => (r.ok ? 'ok' : `${r.error}: ${r.message}`))
          .join('; ')
          .slice(0, 500);
        // Dead tokens are dealt with below and say nothing about the rest.
        const live = rs.filter(
          (r): r is Extract<PushResult, { ok: false }> =>
            !r.ok && r.error !== DEVICE_NOT_REGISTERED,
        );
        const retryable = live.some((r) => r.retryable);
        const providerSide = live.some((r) =>
          isRetryableProviderError(r.error),
        );
        // Anything but a provider-side error, or a push left unsent at the
        // deadline, uses up one of the transport attempts.
        const spent = live.some(
          (r) => r.error !== NOT_SENT && !isRetryableProviderError(r.error),
        );
        const failures = n.transport_failures + (spent ? 1 : 0);
        const tooOld = Date.now() - new Date(n.created_at).getTime() > giveUpMs;
        if (retryable && !tooOld && (!spent || failures < maxAttempts)) {
          const delay = retryDelaySeconds(
            spent ? failures : providerSide ? n.attempts : 1,
          );
          retry.push({ id: n.id, failures, delay, error });
        } else {
          failed.push({ id: n.id, failures, error });
        }
      }
    }

    // A push left unsent at the deadline never reached Expo: no ticket.
    const tickets = sends
      .map((s, i) => ({ ...s, r: results[i] }))
      .filter(({ r }) => r.ok || r.error !== NOT_SENT);
    const deadDevices = sends
      .filter(
        (_, i) =>
          !results[i].ok &&
          (results[i] as { error: string }).error === DEVICE_NOT_REGISTERED,
      )
      .map((s) => s.device.id);

    // Each count is of rows an UPDATE changed: a worker whose claim was taken
    // over changes none, so it counts nothing the new owner will count again.
    const done = { sent: 0, unreachable: 0, withdrawn: 0, failed: 0, retry: 0 };
    const changed = async (
      m: EntityManager,
      sql: string,
      params: unknown[],
    ): Promise<number> => rowsOf(await m.query(sql, params)).length;

    await this.db.transaction(async (m) => {
      if (tickets.length) {
        await m.query(
          `INSERT INTO push_tickets (notification_id, attempt, device_id, expo_ticket_id, status, error, receipt_status)
           SELECT * FROM unnest($1::uuid[], $2::int[], $3::uuid[], $4::varchar[],
                                $5::push_tickets_status_enum[], $6::varchar[],
                                $7::push_tickets_receipt_status_enum[])`,
          [
            tickets.map((t) => t.n.id),
            tickets.map((t) => t.n.attempts),
            tickets.map((t) => t.device.id),
            tickets.map(({ r }) => (r.ok ? r.ticketId : null)),
            tickets.map(({ r }) => (r.ok ? 'ok' : 'error')),
            tickets.map(({ r }) => (r.ok ? null : r.error.slice(0, 64))),
            tickets.map(({ r }) => (r.ok ? 'pending' : 'not_applicable')),
          ],
        );
      }
      if (sent.length) {
        // Confirmed by the phone or seen in the app mid-send: keep that
        // status, and record the send unless an earlier one already is.
        done.sent = await changed(
          m,
          `UPDATE notifications n
           SET status = CASE WHEN n.status = 'sending' THEN 'sent' ELSE n.status END,
               sent_at = CASE WHEN n.status = 'sending' THEN now()
                              ELSE coalesce(n.sent_at, now()) END,
               locked_until = NULL, last_error = NULL, updated_at = now()
           FROM unnest($1::uuid[], $2::int[]) AS c(id, attempts)
           WHERE n.id = c.id AND n.attempts = c.attempts
             AND n.status IN ('sending', 'delivered', 'opened')
           RETURNING n.id`,
          withAttempts(sent),
        );
      }
      if (unreachable.length) {
        done.unreachable = await changed(
          m,
          `UPDATE notifications n SET status = 'unreachable', locked_until = NULL, updated_at = now()
           FROM unnest($1::uuid[], $2::int[]) AS c(id, attempts)
           WHERE n.id = c.id AND n.attempts = c.attempts AND n.status = 'sending'
           RETURNING n.id`,
          withAttempts(unreachable),
        );
      }
      // Withdrawn: nothing was sent, nothing failed, and no email follows
      // for an invitation that is no longer open.
      if (withdrawn.length) {
        done.withdrawn = await changed(
          m,
          `UPDATE notifications n SET status = 'withdrawn', locked_until = NULL, updated_at = now()
           FROM unnest($1::uuid[], $2::int[]) AS c(id, attempts)
           WHERE n.id = c.id AND n.attempts = c.attempts AND n.status = 'sending'
           RETURNING n.id`,
          withAttempts(withdrawn),
        );
      }
      if (failed.length) {
        done.failed = await changed(
          m,
          `UPDATE notifications n SET status = 'failed', locked_until = NULL,
             transport_failures = f.failures, last_error = f.error, updated_at = now()
           FROM unnest($1::uuid[], $2::int[], $3::int[], $4::text[]) AS f(id, attempts, failures, error)
           WHERE n.id = f.id AND n.attempts = f.attempts AND n.status = 'sending'
           RETURNING n.id`,
          [
            ...withAttempts(failed.map((f) => f.id)),
            failed.map((f) => f.failures),
            failed.map((f) => f.error),
          ],
        );
      }
      if (retry.length) {
        done.retry = await changed(
          m,
          `UPDATE notifications n SET status = 'pending', locked_until = NULL,
             transport_failures = r.failures,
             next_attempt_at = now() + make_interval(secs => r.delay),
             last_error = r.error, updated_at = now()
           FROM unnest($1::uuid[], $2::int[], $3::int[], $4::int[], $5::text[])
             AS r(id, attempts, failures, delay, error)
           WHERE n.id = r.id AND n.attempts = r.attempts AND n.status = 'sending'
           RETURNING n.id`,
          [
            ...withAttempts(retry.map((r) => r.id)),
            retry.map((r) => r.failures),
            retry.map((r) => r.delay),
            retry.map((r) => r.error),
          ],
        );
      }
    });
    if (deadDevices.length)
      await this.devices.disable(deadDevices, DEVICE_NOT_REGISTERED);

    for (const [outcome, n] of Object.entries(done))
      if (n) this.metrics.dispatched.labels('all', outcome).inc(n);
    if (done.failed || done.retry) {
      this.logger.warn(
        JSON.stringify({
          msg: 'dispatch problems',
          failed: done.failed,
          retry: done.retry,
        }),
      );
    }
    return claimed.length;
  }

  // Rows stuck in 'sending' past their lease belong to a worker that died.
  async reclaimStale(): Promise<number> {
    const rows = rowsOf(
      await this.db.query(
        `UPDATE notifications SET status = 'pending', locked_until = NULL, updated_at = now()
         WHERE status = 'sending' AND locked_until < now()
         RETURNING id`,
      ),
    );
    if (rows.length)
      this.logger.warn(
        `Reclaimed ${rows.length} notifications from a stalled worker`,
      );
    return rows.length;
  }
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k) ?? [];
    list.push(it);
    m.set(k, list);
  }
  return m;
}
