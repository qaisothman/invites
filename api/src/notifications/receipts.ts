import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../config/env.validation';
import { rowsOf } from '../database/sql';
import { MetricsService } from '../metrics/metrics.service';
import {
  DEVICE_NOT_REGISTERED,
  PUSH_SENDER,
  RETRYABLE_PROVIDER_ERRORS,
} from './providers/push-sender';
import type { PushSender } from './providers/push-sender';

interface DueTicket {
  id: string;
  expo_ticket_id: string;
  notification_id: string;
  created_at: Date;
}

// An Expo ticket only means "Expo accepted it". The receipt, ready about 15
// minutes later, says whether Apple or Google took it. This is where dead
// tokens are found when the send itself looked fine.
@Injectable()
export class ReceiptPoller {
  private readonly logger = new Logger(ReceiptPoller.name);

  constructor(
    private readonly db: DataSource,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly metrics: MetricsService,
  ) {}

  async runOnce(): Promise<number> {
    const delay = this.config.get('RECEIPT_DELAY_SECONDS', { infer: true });
    // receipt_checked_at doubles as a short lease, so two workers never ask
    // Expo about the same tickets at once.
    const due = rowsOf<DueTicket>(
      await this.db.query(
        `UPDATE push_tickets t SET receipt_checked_at = now()
         WHERE t.id IN (
           SELECT id FROM push_tickets
           WHERE receipt_status = 'pending'
             AND created_at < now() - make_interval(secs => $1)
             AND (receipt_checked_at IS NULL OR receipt_checked_at < now() - interval '5 minutes')
           ORDER BY created_at
           LIMIT 1000
           FOR UPDATE SKIP LOCKED)
         RETURNING t.id, t.expo_ticket_id, t.notification_id, t.created_at`,
        [delay],
      ),
    );
    if (due.length === 0) return 0;

    let receipts;
    try {
      receipts = await this.push.getReceipts(due.map((t) => t.expo_ticket_id));
    } catch (e) {
      // Leave them pending; the lease expires and the next round retries.
      this.logger.warn(
        `Receipt fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 0;
    }

    const ok: string[] = [];
    const errors: { id: string; error: string }[] = [];
    const unknown: string[] = [];
    const deadTickets: string[] = [];
    const dayAgo = Date.now() - 86_400_000;
    for (const t of due) {
      const r = receipts[t.expo_ticket_id];
      if (r?.status === 'ok') ok.push(t.id);
      else if (r?.status === 'error') {
        errors.push({ id: t.id, error: r.error.slice(0, 64) });
        if (r.error === DEVICE_NOT_REGISTERED) deadTickets.push(t.id);
      } else if (new Date(t.created_at).getTime() < dayAgo) unknown.push(t.id);
      // else: not ready yet, try again later
    }

    // Every write below applies only to tickets still awaiting a receipt, and
    // to notifications still 'sent', so a late or repeated round can't undo
    // a newer outcome. The metrics count the tickets changed, so it can't
    // count one twice either.
    const counted = { ok: 0, error: 0, unknown: 0 };
    await this.db.transaction(async (m) => {
      if (ok.length) {
        counted.ok = rowsOf(
          await m.query(
            `UPDATE push_tickets SET receipt_status = 'ok'
             WHERE id = ANY($1) AND receipt_status = 'pending' RETURNING id`,
            [ok],
          ),
        ).length;
      }
      if (unknown.length) {
        counted.unknown = rowsOf(
          await m.query(
            `UPDATE push_tickets SET receipt_status = 'unknown'
             WHERE id = ANY($1) AND receipt_status = 'pending' RETURNING id`,
            [unknown],
          ),
        ).length;
      }
      if (errors.length) {
        counted.error = rowsOf(
          await m.query(
            `UPDATE push_tickets t SET receipt_status = 'error', receipt_error = e.error
             FROM unnest($1::uuid[], $2::varchar[]) AS e(id, error)
             WHERE t.id = e.id AND t.receipt_status = 'pending' RETURNING t.id`,
            [errors.map((e) => e.id), errors.map((e) => e.error)],
          ),
        ).length;
        const affected = [
          ...new Set(
            due
              .filter((t) => errors.some((e) => e.id === t.id))
              .map((t) => t.notification_id),
          ),
        ];
        // No ticket of the notification is still alive (ok or awaiting a
        // receipt): it never reached a phone, whatever the send said.
        const nothingAlive = `NOT EXISTS (
            SELECT 1 FROM push_tickets t
            WHERE t.notification_id = n.id AND t.status = 'ok'
              AND t.receipt_status IN ('pending', 'ok', 'unknown'))`;
        // Rate-limited by Apple or Google (Expo's advice is to back off and
        // retry), or our credentials are broken (retry once they're fixed):
        // put it back in the outbox, 30 s per attempt, up to 30 min apart.
        // Only the latest send's receipts count (t.attempt = n.attempts): an
        // earlier send's rate limit says nothing once a later one was
        // rejected for good. Like the same errors at send time, this doesn't
        // use up attempts; it stops once the notification is
        // PUSH_GIVE_UP_AFTER_HOURS old.
        const latest = `t.notification_id = n.id AND t.attempt = n.attempts
                 AND t.receipt_error = ANY($3)`;
        await m.query(
          `UPDATE notifications n SET status = 'pending',
             next_attempt_at = now() + make_interval(secs => least(1800, 30 * n.attempts)),
             last_error = 'receipt: ' || (
               SELECT t.receipt_error FROM push_tickets t WHERE ${latest} LIMIT 1),
             updated_at = now()
           WHERE n.id = ANY($1) AND n.status = 'sent' AND n.delivered_at IS NULL
             AND n.created_at > now() - make_interval(hours => $2)
             AND ${nothingAlive}
             AND EXISTS (SELECT 1 FROM push_tickets t WHERE ${latest})`,
          [
            affected,
            this.config.get('PUSH_GIVE_UP_AFTER_HOURS', { infer: true }),
            RETRYABLE_PROVIDER_ERRORS,
          ],
        );
        // Anything else rejected is final: mark it failed.
        await m.query(
          `UPDATE notifications n SET status = 'failed',
             last_error = 'all receipts rejected', updated_at = now()
           WHERE n.id = ANY($1) AND n.status = 'sent' AND n.delivered_at IS NULL
             AND ${nothingAlive}`,
          [affected],
        );
      }
      // The receipt comes about 15 minutes after the send. A phone that
      // registered again since then has a working token: leave it enabled.
      if (deadTickets.length) {
        await m.query(
          `UPDATE devices d SET disabled_at = now(), disabled_reason = $2
           FROM push_tickets t
           WHERE t.id = ANY($1) AND d.id = t.device_id
             AND d.disabled_at IS NULL AND d.last_seen_at <= t.created_at`,
          [deadTickets, DEVICE_NOT_REGISTERED],
        );
      }
    });

    for (const [outcome, n] of Object.entries(counted))
      if (n) this.metrics.receipts.labels(outcome).inc(n);
    return due.length;
  }
}
