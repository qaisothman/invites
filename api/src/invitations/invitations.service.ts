import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterCursor, decodeCursor, page } from '../common/pagination';
import type { AppConfig } from '../config/env.validation';
import { isUniqueViolation, rowsOf } from '../database/sql';
import { NotificationType } from '../notifications/notification-types';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/user.entity';
import {
  Invitation,
  InvitationStatus,
  toInvitationView,
} from './invitation.entity';
import { CreateInvitationDto, ListInvitationsQuery } from './invitations.dto';

const receivedKey = (id: string) => `invitation:${id}:received`;
const acceptedKey = (id: string) => `invitation:${id}:accepted`;

@Injectable()
export class InvitationsService {
  constructor(
    private readonly db: DataSource,
    @InjectRepository(Invitation)
    private readonly invitations: Repository<Invitation>,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async create(inviterId: string, dto: CreateInvitationDto) {
    if (dto.inviteeId === inviterId) {
      throw new BadRequestException({
        code: 'cannot_invite_self',
        message: 'You cannot invite yourself',
      });
    }
    const ttlDays = this.config.get('INVITE_TTL_DAYS', { infer: true });
    const linkBase = this.config.get('APP_LINK_BASE', { infer: true });

    const id = await this.db.transaction(async (m) => {
      const [inviter, invitee] = await Promise.all([
        m.findOneByOrFail(User, { id: inviterId }),
        m.findOneBy(User, { id: dto.inviteeId }),
      ]);
      if (!invitee)
        throw new NotFoundException({
          code: 'user_not_found',
          message: 'That member does not exist',
        });

      // An invitation past its expiry that the sweeper hasn't marked yet
      // doesn't block a new one: answering it already says it has expired.
      await m.query(
        `UPDATE invitations SET status = 'expired', updated_at = now()
         WHERE inviter_id = $1 AND invitee_id = $2 AND status = 'pending' AND expires_at <= now()`,
        [inviterId, invitee.id],
      );

      let invitation: Invitation;
      try {
        invitation = await m.save(
          m.create(Invitation, {
            inviterId,
            inviteeId: invitee.id,
            message: dto.message || null,
            expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
          }),
        );
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new ConflictException({
            code: 'invitation_already_pending',
            message: 'You already have an open invitation to this member',
          });
        }
        throw e;
      }

      // Same transaction: the notification exists if and only if the
      // invitation does. See NotificationsService.enqueue.
      await this.notifications.enqueue(m, {
        userId: invitee.id,
        type: NotificationType.InvitationReceived,
        // The name and nothing else: pushes show on lock screens, so the
        // message itself stays in the app (and out of emails, too).
        title: `${inviter.displayName} invited you`,
        body: 'Tap to see the invitation',
        data: {
          invitationId: invitation.id,
          url: `${linkBase}/i/${invitation.id}`,
        },
        dedupeKey: receivedKey(invitation.id),
      });
      return invitation.id;
    });
    return toInvitationView(await this.load(id));
  }

  async list(userId: string, q: ListInvitationsQuery) {
    const cursor = decodeCursor(q.cursor);
    const qb = this.invitations
      .createQueryBuilder('i')
      .leftJoinAndSelect('i.inviter', 'inviter')
      .leftJoinAndSelect('i.invitee', 'invitee')
      .where(
        q.box === 'received'
          ? 'i.invitee_id = :userId'
          : 'i.inviter_id = :userId',
        { userId },
      )
      // Property names, not column names: TypeORM needs them to paginate
      // correctly when the query has joins.
      .orderBy('i.createdAt', 'DESC')
      .addOrderBy('i.id', 'DESC')
      .take(q.limit + 1);
    if (q.status) qb.andWhere('i.status = :status', { status: q.status });
    if (cursor) qb.andWhere(afterCursor('invitations', 'i'), cursor);
    const { items, nextCursor } = page(await qb.getMany(), q.limit);
    return { items: items.map(toInvitationView), nextCursor };
  }

  // Visible to the two people involved and nobody else. A stranger gets 404,
  // not 403, so ids can't be probed for existence.
  async getForUser(id: string, userId: string) {
    const inv = await this.load(id);
    if (inv.inviterId !== userId && inv.inviteeId !== userId)
      throw this.notFound();
    if (inv.inviteeId === userId && !inv.openedAt) {
      await this.db.transaction(async (m) => {
        await m.query(
          `UPDATE invitations SET opened_at = coalesce(opened_at, now()), updated_at = now() WHERE id = $1`,
          [id],
        );
        await this.notifications.markSeenByDedupeKey(m, receivedKey(id));
      });
      return toInvitationView(await this.load(id));
    }
    return toInvitationView(inv);
  }

  // Idempotent: accepting an accepted invitation returns it unchanged, so a
  // retried request after a timeout is harmless. Only the first response
  // wins; the conditional UPDATE makes that true even with two in parallel.
  async respond(id: string, userId: string, decision: 'accept' | 'decline') {
    const target =
      decision === 'accept'
        ? InvitationStatus.Accepted
        : InvitationStatus.Declined;
    const linkBase = this.config.get('APP_LINK_BASE', { infer: true });

    await this.db.transaction(async (m) => {
      const updated = rowsOf<{ inviter_id: string }>(
        await m.query(
          `UPDATE invitations
           SET status = $3, responded_at = now(), opened_at = coalesce(opened_at, now()), updated_at = now()
           WHERE id = $1 AND invitee_id = $2 AND status = 'pending' AND expires_at > now()
           RETURNING inviter_id`,
          [id, userId, target],
        ),
      );
      if (updated.length === 1) {
        await this.notifications.markSeenByDedupeKey(m, receivedKey(id));
        if (target === InvitationStatus.Accepted) {
          const invitee = await m.findOneByOrFail(User, { id: userId });
          await this.notifications.enqueue(m, {
            userId: updated[0].inviter_id,
            type: NotificationType.InvitationAccepted,
            title: `${invitee.displayName} accepted your invitation`,
            body: 'Tap to say hello',
            data: { invitationId: id, url: `${linkBase}/i/${id}` },
            dedupeKey: acceptedKey(id),
          });
        }
        return;
      }

      // Nothing changed: explain why.
      const inv = await m.findOneBy(Invitation, { id, inviteeId: userId });
      if (!inv) throw this.notFound();
      if (inv.status === target) return; // a replay of the same answer
      // Still pending, yet the UPDATE skipped it: only expiry, as the
      // database's clock saw it, explains that.
      if (
        inv.status === InvitationStatus.Expired ||
        inv.status === InvitationStatus.Pending
      ) {
        throw new GoneException({
          code: 'invitation_expired',
          message: 'This invitation has expired',
        });
      }
      if (inv.status === InvitationStatus.Cancelled) {
        throw new GoneException({
          code: 'invitation_cancelled',
          message: 'This invitation was withdrawn',
        });
      }
      throw new ConflictException({
        code: 'invitation_already_responded',
        message: `This invitation was already ${inv.status}`,
      });
    });
    return toInvitationView(await this.load(id));
  }

  async cancel(id: string, userId: string) {
    const res = await this.invitations.update(
      { id, inviterId: userId, status: InvitationStatus.Pending },
      { status: InvitationStatus.Cancelled },
    );
    if (!res.affected) {
      const inv = await this.invitations.findOneBy({ id, inviterId: userId });
      if (!inv) throw this.notFound();
      if (inv.status !== InvitationStatus.Cancelled) {
        throw new ConflictException({
          code: 'invitation_not_pending',
          message: `This invitation is ${inv.status}`,
        });
      }
    }
    return toInvitationView(await this.load(id));
  }

  // Runs on the worker every few minutes.
  async expireDue(): Promise<number> {
    const rows = rowsOf(
      await this.db.query(
        `UPDATE invitations SET status = 'expired', updated_at = now()
         WHERE status = 'pending' AND expires_at <= now()
         RETURNING id`,
      ),
    );
    return rows.length;
  }

  private async load(id: string) {
    const inv = await this.invitations.findOne({
      where: { id },
      relations: { inviter: true, invitee: true },
    });
    if (!inv) throw this.notFound();
    return inv;
  }

  private notFound() {
    return new NotFoundException({
      code: 'invitation_not_found',
      message: 'Invitation not found',
    });
  }
}
