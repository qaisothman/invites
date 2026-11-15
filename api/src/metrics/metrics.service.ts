import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import { DataSource } from 'typeorm';

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

  readonly deviceReports = new Counter({
    name: 'device_reports_total',
    help: 'Phones reporting in, by platform, notifications state and app version',
    labelNames: ['platform', 'notifications', 'app_version'] as const,
    registers: [this.registry],
  });

  constructor(private readonly db: DataSource) {
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
