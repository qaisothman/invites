import {
  Check,
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

export enum InvitationStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
  Cancelled = 'cancelled',
  Expired = 'expired',
}

@Entity('invitations')
@Check('invitations_not_self', `"inviter_id" <> "invitee_id"`)
// At most one open invitation from one member to another (the reverse
// direction is a separate invitation). Enforced by the database, so a
// double-tapped "Invite" button can't create two.
@Index('invitations_one_pending_per_pair', ['inviterId', 'inviteeId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
@Index('invitations_received_idx', ['inviteeId', 'createdAt'])
@Index('invitations_sent_idx', ['inviterId', 'createdAt'])
@Index('invitations_pending_expiry_idx', ['expiresAt'], {
  where: `"status" = 'pending'`,
})
@Index('invitations_created_idx', ['createdAt'])
export class Invitation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  inviterId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inviter_id' })
  inviter?: User;

  @Column({ type: 'uuid' })
  inviteeId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invitee_id' })
  invitee?: User;

  @Column({ type: 'varchar', length: 280, nullable: true })
  message: string | null;

  @Column({
    type: 'enum',
    enum: InvitationStatus,
    default: InvitationStatus.Pending,
  })
  status: InvitationStatus;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  // First time the invitee looked at it in the app.
  @Column({ type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

export function toInvitationView(i: Invitation) {
  return {
    id: i.id,
    status: i.status,
    message: i.message,
    inviter: i.inviter
      ? { id: i.inviter.id, displayName: i.inviter.displayName }
      : { id: i.inviterId },
    invitee: i.invitee
      ? { id: i.invitee.id, displayName: i.invitee.displayName }
      : { id: i.inviteeId },
    expiresAt: i.expiresAt,
    openedAt: i.openedAt,
    respondedAt: i.respondedAt,
    createdAt: i.createdAt,
  };
}
