import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  Member = 'member',
  Admin = 'admin',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Stored lower-cased, so the unique index is effectively case-insensitive.
  @Column({ type: 'varchar', length: 320, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 80 })
  displayName: string;

  // `select: false` keeps the hash out of every query unless asked for by name.
  @Column({ type: 'varchar', length: 100, select: false })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.Member })
  role: UserRole;

  // Email me about invitations when no phone of mine can show them. On by
  // default, off from Profile or from the link in any of those emails.
  @Column({ type: 'boolean', default: true })
  invitationEmails: boolean;

  // When the last invitation email was claimed for this person: the claim
  // that keeps it to one a day, even with several workers (see
  // InvitationEmailer).
  @Column({ type: 'timestamptz', nullable: true, select: false })
  lastInvitationEmailAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

export type PublicUser = Pick<User, 'id' | 'displayName'>;

export function toMe(u: User) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    invitationEmails: u.invitationEmails,
    createdAt: u.createdAt,
  };
}
