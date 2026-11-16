import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AuthService } from '../auth/auth.service';
import type { AppConfig } from '../config/env.validation';
import { InvitationsService } from '../invitations/invitations.service';
import { OutboxDispatcher } from '../notifications/dispatcher';
import {
  InvitationEmailer,
  PEOPLE_PER_RUN,
} from '../notifications/invitation-emails';
import { ReceiptPoller } from '../notifications/receipts';

// Starts the background loops when WORKERS_ENABLED is true. The API and the
// worker are the same image; production runs it twice, once with the flag
// off (serves HTTP, scales with traffic) and once with it on (drains the
// outbox, scales with backlog).
@Injectable()
export class WorkerRunner
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerRunner.name);
  private stopping = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly scheduler: SchedulerRegistry,
    private readonly dispatcher: OutboxDispatcher,
    private readonly receipts: ReceiptPoller,
    private readonly emails: InvitationEmailer,
    private readonly invitations: InvitationsService,
    private readonly auth: AuthService,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.get('WORKERS_ENABLED', { infer: true })) return;
    const batchSize = this.config.get('DISPATCH_BATCH_SIZE', { infer: true });

    // Drain: while a batch comes back full there is more waiting, so go again
    // straight away instead of sleeping until the next tick.
    this.every(
      'dispatch',
      this.config.get('DISPATCH_INTERVAL_MS', { infer: true }),
      async () => {
        while (
          !this.stopping &&
          (await this.dispatcher.runOnce()) === batchSize
        ) {
          /* keep draining */
        }
      },
    );
    this.every('reclaim-stale', 30_000, () => this.dispatcher.reclaimStale());
    this.every('receipts', 30_000, () => this.receipts.runOnce());
    // Same drain as the dispatcher: a full pass means more people waiting.
    // People whose email was just refused wait out a retry delay, so they
    // aren't picked again straight away.
    this.every('invitation-emails', 60_000, async () => {
      while (
        !this.stopping &&
        (await this.emails.runOnce()) === PEOPLE_PER_RUN
      ) {
        /* keep draining */
      }
    });
    this.every('expire-invitations', 5 * 60_000, () =>
      this.invitations.expireDue(),
    );
    // Hourly rather than daily: the interval restarts with every deploy.
    this.every('prune-sessions', 3_600_000, () =>
      this.auth.pruneExpiredSessions(),
    );
    this.logger.log('Workers started');
  }

  // SIGTERM during a deploy: stop starting new work, finish what's running,
  // then let the process exit. No batch is abandoned halfway.
  async onApplicationShutdown() {
    this.stopping = true;
    for (const name of this.scheduler.getIntervals())
      this.scheduler.deleteInterval(name);
    await Promise.allSettled([...this.inFlight]);
  }

  // setInterval that never overlaps itself: if a run is still going when the
  // next tick fires, that tick is skipped.
  private every(name: string, ms: number, fn: () => Promise<unknown>) {
    let running = false;
    const handle = setInterval(() => {
      if (running || this.stopping) return;
      running = true;
      const run = fn()
        .catch((e: unknown) =>
          this.logger.error(
            `${name} failed`,
            e instanceof Error ? e.stack : String(e),
          ),
        )
        .finally(() => {
          running = false;
          this.inFlight.delete(run);
        });
      this.inFlight.add(run);
    }, ms);
    this.scheduler.addInterval(name, handle);
  }
}
