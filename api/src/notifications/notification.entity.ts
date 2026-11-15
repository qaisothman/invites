import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

// Lifecycle of one notification to one user (see docs/03-data-model.md):
//
//   pending -> sending -> sent -> delivered -> opened
//      ^          |
//      +- retry --+--> failed | unreachable | withdrawn
//
// pending/sending are the outbox. sent means Expo accepted it; delivered means
// the app confirmed it arrived; opened means the user tapped it or saw the
// invitation in the app. unreachable means no phone of theirs could show it
// (none signed in, notifications off on all, or only an Android phone silent
// for 90 days), or every token was dead. withdrawn means the invitation was
// cancelled or expired before the push went out: nothing was sent, and
// nothing failed.
export enum NotificationStatus {
  Pending = 'pending',
  Sending = 'sending',
  Sent = 'sent',
  Delivered = 'delivered',
  Opened = 'opened',
  Failed = 'failed',
  Unreachable = 'unreachable',
  Withdrawn = 'withdrawn',
}

// The invitation email for invitees push can't reach (see ADR 0006).
export enum EmailStatus {
  None = 'none',
  Pending = 'pending',
  Sent = 'sent',
  Failed = 'failed',
  OptedOut = 'opted_out',
}

@Entity('notifications')
// The dispatcher's claim query: due rows only, so the index stays small even
// when the table holds millions of finished notifications.
@Index('notifications_due_idx', ['nextAttemptAt'], {
  where: `"status" = 'pending'`,
})
// Rows a crashed worker left in 'sending'.
@Index('notifications_stale_sending_idx', ['lockedUntil'], {
  where: `"status" = 'sending'`,
})
// Candidates for the invitation email: rows push couldn't deliver whose
// email is undecided. The emailer reads only its last INVITE_TTL_DAYS.
@Index('notifications_email_due_idx', ['createdAt'], {
  where: `"email_status" = 'none' AND "status" IN ('unreachable', 'failed')`,
})
// Email claims in flight, for reclaiming those a dead worker left behind.
@Index('notifications_email_pending_idx', ['emailAt'], {
  where: `"email_status" = 'pending'`,
})
@Index('notifications_user_created_idx', ['userId', 'createdAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'varchar', length: 64 })
  type: string;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'varchar', length: 400 })
  body: string;

  @Column({ type: 'jsonb', default: {} })
  data: Record<string, unknown>;

  // Makes enqueueing idempotent: the same business event can't produce two
  // notifications, even if the code that triggers it runs twice.
  @Column({ type: 'varchar', length: 200, unique: true })
  dedupeKey: string;

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    default: NotificationStatus.Pending,
  })
  status: NotificationStatus;

  // Claims so far. Each claim takes the next number, and a result is written
  // only under the number it was claimed with: a fencing token.
  @Column({ type: 'int', default: 0 })
  attempts: number;

  // Claims that ended in a transport failure (network, timeout, Expo 429 or
  // 5xx): what PUSH_MAX_ATTEMPTS limits. Provider-side errors, and pushes
  // left unsent at the send deadline, don't add to it.
  @Column({ type: 'int', default: 0 })
  transportFailures: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  // Lease: a worker owns a 'sending' row until this time. If it crashes, the
  // row becomes claimable again after the lease ends.
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ type: 'enum', enum: EmailStatus, default: EmailStatus.None })
  emailStatus: EmailStatus;

  @Column({ type: 'timestamptz', nullable: true })
  emailAt: Date | null;

  @Column({ type: 'int', default: 0 })
  emailAttempts: number;

  @Column({ type: 'text', nullable: true })
  emailError: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
