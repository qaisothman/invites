import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  afterCursor,
  decodeCursor,
  page,
  PageQuery,
} from '../common/pagination';
import { rowsOf } from '../database/sql';
import { Notification } from './notification.entity';

export interface EnqueueInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  dedupeKey: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: DataSource,
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  // The transactional outbox. Takes the caller's EntityManager, so the row is
  // written in the same transaction as the business change (the invitation).
  // Either both commit or neither does: no invitation without its
  // notification, no notification for an invitation that rolled back.
  // Sending happens later, in the dispatcher, never inside the transaction.
  async enqueue(manager: EntityManager, input: EnqueueInput): Promise<void> {
    await manager.query(
      `INSERT INTO notifications (user_id, type, title, body, data, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        input.userId,
        input.type,
        input.title,
        input.body,
        JSON.stringify(input.data),
        input.dedupeKey,
      ],
    );
  }

  // Delivery confirmed by the signed token from the push (see AckTokens),
  // from a background task that may have no session.
  async markDeliveredById(id: string) {
    const rows = rowsOf(
      await this.db.query(
        `UPDATE notifications
         SET delivered_at = coalesce(delivered_at, now()),
             status = CASE WHEN status = 'opened' THEN status ELSE 'delivered' END,
             updated_at = now()
         WHERE id = $1
         RETURNING id`,
        [id],
      ),
    );
    if (rows.length === 0) throw this.notFound();
  }

  // The app reports that a push arrived. A notification can only move
  // forward: an "opened" one never goes back to "delivered".
  async markDelivered(id: string, userId: string) {
    const rows = rowsOf(
      await this.db.query(
        `UPDATE notifications
         SET delivered_at = coalesce(delivered_at, now()),
             status = CASE WHEN status = 'opened' THEN status ELSE 'delivered' END,
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id`,
        [id, userId],
      ),
    );
    if (rows.length === 0) throw this.notFound();
  }

  async markOpened(id: string, userId: string) {
    const rows = rowsOf(
      await this.db.query(
        `UPDATE notifications
         SET delivered_at = coalesce(delivered_at, now()),
             opened_at = coalesce(opened_at, now()),
             status = 'opened',
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING id`,
        [id, userId],
      ),
    );
    if (rows.length === 0) throw this.notFound();
  }

  // The user saw the thing the notification is about inside the app (for
  // example opened the invitation from their inbox). Counts as opened, and
  // stops the push and the invitation email about something they've already
  // seen. Not as delivered: delivered_at is only ever a phone confirming the
  // push.
  async markSeenByDedupeKey(manager: EntityManager, dedupeKey: string) {
    await manager.query(
      `UPDATE notifications
       SET opened_at = coalesce(opened_at, now()),
           status = 'opened',
           updated_at = now()
       WHERE dedupe_key = $1 AND opened_at IS NULL`,
      [dedupeKey],
    );
  }

  async list(userId: string, q: PageQuery) {
    const cursor = decodeCursor(q.cursor);
    const qb = this.notifications
      .createQueryBuilder('n')
      .where('n.user_id = :userId', { userId })
      .orderBy('n.createdAt', 'DESC')
      .addOrderBy('n.id', 'DESC')
      .take(q.limit + 1);
    if (cursor) qb.andWhere(afterCursor('notifications', 'n'), cursor);
    const rows = await qb.getMany();
    const { items, nextCursor } = page(rows, q.limit);
    return {
      items: items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data,
        status: n.status,
        createdAt: n.createdAt,
        openedAt: n.openedAt,
      })),
      nextCursor,
    };
  }

  private notFound() {
    return new NotFoundException({
      code: 'notification_not_found',
      message: 'Notification not found',
    });
  }
}
