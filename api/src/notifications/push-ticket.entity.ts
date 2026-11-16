import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Device } from '../devices/device.entity';
import { Notification } from './notification.entity';

export enum TicketStatus {
  Ok = 'ok',
  Error = 'error',
}

export enum ReceiptStatus {
  Pending = 'pending',
  Ok = 'ok',
  Error = 'error',
  // Expo keeps receipts for about a day; after that we can't know.
  Unknown = 'unknown',
  // The send itself failed, so there is no receipt to fetch.
  NotApplicable = 'not_applicable',
}

// One row per (notification, device) send. Expo answers a send with a
// ticket; about 15 minutes later the receipt says whether Apple or Google
// actually accepted it. Both are kept, so "why didn't I get it?" has an answer.
@Entity('push_tickets')
@Index('push_tickets_receipt_due_idx', ['createdAt'], {
  where: `"receipt_status" = 'pending'`,
})
@Index('push_tickets_notification_idx', ['notificationId'])
export class PushTicket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  notificationId: string;

  @ManyToOne(() => Notification, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'notification_id' })
  notification?: Notification;

  // The notification's claim number (its `attempts`) for the send that made
  // this ticket, so a receipt is judged against the latest send only.
  @Column({ type: 'int' })
  attempt: number;

  @Column({ type: 'uuid' })
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device?: Device;

  @Column({ type: 'varchar', length: 64, nullable: true })
  expoTicketId: string | null;

  @Column({ type: 'enum', enum: TicketStatus })
  status: TicketStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  error: string | null;

  @Column({ type: 'enum', enum: ReceiptStatus })
  receiptStatus: ReceiptStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  receiptError: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  receiptCheckedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
