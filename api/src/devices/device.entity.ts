import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

export enum Platform {
  Ios = 'ios',
  Android = 'android',
}

// What the phone last said about showing our notifications. The app reports
// it on launch, on a new token, and on returning to the foreground when it
// changed or 15 minutes have passed, because the server can't see it any
// other way: Apple, Google and Expo accept pushes for a phone with
// notifications off and report success.
export enum NotificationsState {
  Allowed = 'allowed', // the OS will show our pushes
  Off = 'off', // denied, turned off in Settings, or the invitations channel blocked
  NotAsked = 'not_asked', // not allowed yet, but the OS would still show its prompt
}

// A phone that can receive push. One user can have several; a token moves to
// the new owner when someone signs into the same phone with another account.
@Entity('devices')
@Index('devices_active_by_user_idx', ['userId'], {
  where: '"disabled_at" IS NULL',
})
export class Device {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'varchar', length: 255, unique: true })
  expoPushToken: string;

  @Column({ type: 'enum', enum: Platform })
  platform: Platform;

  @Column({ type: 'varchar', length: 32, nullable: true })
  appVersion: string | null;

  // Optional on POST /devices; a report without it counts as allowed.
  @Column({
    type: 'enum',
    enum: NotificationsState,
    default: NotificationsState.Allowed,
  })
  notifications: NotificationsState;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;

  // Set when Expo says the token is dead (usually the app was uninstalled) or
  // on sign-out. Disabled devices are skipped, never deleted, so the history
  // of why a push wasn't sent survives.
  @Column({ type: 'timestamptz', nullable: true })
  disabledAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  disabledReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
