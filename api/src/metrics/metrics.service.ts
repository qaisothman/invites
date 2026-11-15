import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import { DataSource } from 'typeorm';
import type { AppConfig } from '../config/env.validation';
import { EMAIL_ELIGIBLE } from '../notifications/email-eligibility';
import { EMAIL_TYPES } from '../notifications/notification-types';

// Prometheus metrics. Counters and histograms are updated in-process; the
// outbox gauges are computed from the database each time /metrics is scraped,
// so every instance reports the same backlog. With the database unreachable
// a gauge reads NaN and the scrape still succeeds, so the HTTP and dispatch
// series keep reaching Prometheus.
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration by route and status',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly dispatched = new Counter({
    name: 'notifications_dispatched_total',
    help: 'Outcome of each dispatch attempt',
    labelNames: ['type', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly pushRequest = new Histogram({
    name: 'push_provider_request_seconds',
    help: 'Latency of calls to the push provider',
    labelNames: ['op', 'outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  readonly receipts = new Counter({
    name: 'push_receipts_total',
    help: 'Push receipts by outcome',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly invitationEmails = new Counter({
    name: 'invitation_emails_total',
    help: 'Invitations emailed to people push could not reach, by outcome (one per invitation; several can share an email)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly deviceReports = new Counter({
    name: 'device_reports_total',
    help: 'Phones reporting in, by platform, notifications state and app version',
    labelNames: ['platform', 'notifications', 'app_version'] as const,
    registers: [this.registry],
  });

  constructor(
    private readonly db: DataSource,
    config: ConfigService<AppConfig, true>,
  ) {
    collectDefaultMetrics({ register: this.registry });
    const db_ = this.db;
    // The one value a gauge's query selects.
    const read = async (sql: string, params?: unknown[]): Promise<number> => {
      try {
        const [r] = await db_.query<Record<string, number>[]>(sql, params);
        return Object.values(r)[0];
      } catch {
        return Number.NaN;
      }
    };
    const emailAfter = config.get('EMAIL_AFTER_SECONDS', { infer: true });
    const ttlDays = config.get('INVITE_TTL_DAYS', { infer: true });
    // Every outcome exists from the start, so increase() sees the first
    // failure after a restart instead of a series appearing.
    for (const o of ['sent', 'retry', 'failed', 'opted_out'])
      this.invitationEmails.labels(o).inc(0);

    new Gauge({
      name: 'invitation_emails_oldest_due_seconds',
      help: 'How long the oldest invitation that should be emailed by now has been waiting past EMAIL_AFTER_SECONDS',
      registers: [this.registry],
      async collect() {
        // The emailer's own rule, without the per-person daily cap: what's
        // held by the cap is waiting by design. A refused email waiting to
        // be retried still counts, so a provider outage shows here.
        this.set(
          await read(
            `SELECT coalesce(extract(epoch FROM now() - min(n.created_at)) - $2, 0)::float AS s
             FROM notifications n, invitations i, users u
             WHERE ${EMAIL_ELIGIBLE} AND u.id = n.user_id
               AND u.invitation_emails
               AND (u.last_invitation_email_at IS NULL
                    OR u.last_invitation_email_at <= now() - interval '24 hours')`,
            [EMAIL_TYPES, emailAfter, ttlDays],
          ),
        );
      },
    });

    new Gauge({
      name: 'outbox_due',
      help: 'Notifications waiting to be sent now',
      registers: [this.registry],
      async collect() {
        this.set(
          await read(
            `SELECT count(*)::int AS n FROM notifications
             WHERE status = 'pending' AND next_attempt_at <= now()`,
          ),
        );
      },
    });

    new Gauge({
      name: 'outbox_oldest_due_seconds',
      help: 'Age of the oldest notification waiting to be sent',
      registers: [this.registry],
      async collect() {
        this.set(
          await read(
            `SELECT coalesce(extract(epoch FROM now() - min(next_attempt_at)), 0)::float AS s
             FROM notifications WHERE status = 'pending' AND next_attempt_at <= now()`,
          ),
        );
      },
    });
  }
}
