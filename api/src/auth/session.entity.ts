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

// One row per refresh token. Tokens rotate on every use; all rotations of one
// sign-in share a familyId. If a token that was already rotated is presented
// again, someone copied it, so the whole family is revoked; the one exception
// is a quick retry whose successor was never used (a lost response).
@Entity('sessions')
@Index('sessions_family_idx', ['familyId'])
@Index('sessions_user_idx', ['userId'])
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'uuid' })
  familyId: string;

  // SHA-256 of the token. The token itself is never stored.
  @Column({ type: 'char', length: 64, unique: true })
  tokenHash: string;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  // The token that replaced this one when it was rotated. Null for a token
  // revoked by sign-out or reuse detection. It's what tells a retry of the
  // previous token apart from a stolen copy (AuthService.refresh). No
  // foreign key: it's written in the statement that revokes this row,
  // before the successor row exists.
  @Column({ type: 'uuid', nullable: true })
  replacedBy: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
