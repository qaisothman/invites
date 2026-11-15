import {
  ConflictException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import type { AppConfig } from '../config/env.validation';
import { toMe, User } from '../users/user.entity';
import { isUniqueViolation, rowsOf } from '../database/sql';
import { AccessTokenPayload } from './auth-user';
import { LoginDto, RegisterDto } from './auth.dto';
import { hashPassword, verifyPassword } from './password';
import { Session } from './session.entity';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
type Rotated = { user_id: string; family_id: string };

@Injectable()
export class AuthService implements OnModuleInit {
  // Compared against when the email doesn't exist, so sign-in timing doesn't
  // show whether the account is real. Sign-up still answers email_taken, and
  // the invite lookup finds a member by exact email.
  private dummyHash = '';

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    private readonly db: DataSource,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async onModuleInit() {
    this.dummyHash = await hashPassword(randomUUID(), this.cost());
  }

  private cost() {
    return this.config.get('PASSWORD_HASH_COST', { infer: true });
  }

  async register(dto: RegisterDto, userAgent?: string) {
    const passwordHash = await hashPassword(dto.password, this.cost());
    let user: User;
    try {
      user = await this.users.save(
        this.users.create({
          email: dto.email,
          displayName: dto.displayName,
          passwordHash,
        }),
      );
    } catch (e) {
      // Rely on the unique index, not a SELECT first: two sign-ups racing
      // with the same email would both pass a SELECT.
      if (isUniqueViolation(e)) {
        throw new ConflictException({
          code: 'email_taken',
          message: 'That email is already registered',
        });
      }
      throw e;
    }
    return this.issue(user, randomUUID(), userAgent);
  }

  async login(dto: LoginDto, userAgent?: string) {
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email: dto.email })
      .getOne();
    const ok = await verifyPassword(
      dto.password,
      user?.passwordHash ?? this.dummyHash,
    );
    if (!user || !ok) {
      throw new UnauthorizedException({
        code: 'invalid_credentials',
        message: 'Email or password is wrong',
      });
    }
    return this.issue(user, randomUUID(), userAgent);
  }

  async refresh(refreshToken: string, userAgent?: string) {
    const tokenHash = sha256(refreshToken);
    const grace = this.config.get('REFRESH_GRACE_SECONDS', { infer: true });

    const issued = await this.db.transaction(async (m) => {
      // The successor's id is chosen first so the revoking UPDATE can record
      // it; its row is inserted at the end of this transaction.
      const nextId = randomUUID();

      // Normal rotation: revoke-and-check in one statement. Of two requests
      // racing with one token only one matches; the other waits for it to
      // commit and is then judged by the grace rule below.
      let [row] = rowsOf<Rotated>(
        await m.query(
          `UPDATE sessions SET revoked_at = now(), replaced_by = $2
           WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
           RETURNING user_id, family_id`,
          [tokenHash, nextId],
        ),
      );

      // Grace: the previous token again, within seconds of its rotation,
      // while its successor is still unused. The response that carried the
      // successor was most likely lost. The unused successor is replaced,
      // not kept, so a family never has more than one live token.
      if (!row && grace > 0) {
        // Lock the presented token's row first, so retries of one token take
        // turns: each sees the successor the previous retry wrote.
        const [prev] = rowsOf<{ replaced_by: string }>(
          await m.query(
            `SELECT replaced_by FROM sessions
             WHERE token_hash = $1 AND replaced_by IS NOT NULL
               AND revoked_at > now() - make_interval(secs => $2)
             FOR UPDATE`,
            [tokenHash, grace],
          ),
        );
        if (prev) {
          [row] = rowsOf<Rotated>(
            await m.query(
              `UPDATE sessions SET revoked_at = now(), replaced_by = $2
               WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
               RETURNING user_id, family_id`,
              [prev.replaced_by, nextId],
            ),
          );
        }
        if (row) {
          await m.query(
            'UPDATE sessions SET replaced_by = $2 WHERE token_hash = $1',
            [tokenHash, nextId],
          );
        }
      }

      if (!row) return null;
      const user = await m.findOneByOrFail(User, { id: row.user_id });
      return this.issue(user, row.family_id, userAgent, m, nextId);
    });
    if (issued) return issued;

    const known = await this.sessions.findOneBy({ tokenHash });
    if (known?.revokedAt) {
      // Rotated and its successor already used, or rotated too long ago, or
      // signed out: someone has a copy. Sign the whole family out.
      await this.revokeFamily(known.familyId);
      throw new UnauthorizedException({
        code: 'refresh_token_reused',
        message: 'Signed out for safety, please sign in again',
      });
    }
    throw new UnauthorizedException({
      code: 'invalid_refresh_token',
      message: 'Please sign in again',
    });
  }

  async logout(refreshToken: string) {
    const known = await this.sessions.findOneBy({
      tokenHash: sha256(refreshToken),
    });
    if (known) await this.revokeFamily(known.familyId);
  }

  // Locks the family's rows first (oldest first, the order a rotation takes
  // them), which waits for a refresh in flight to commit; the UPDATE, a new
  // statement, then also sees the token that refresh issued. A refresh that
  // starts after the lock finds its token revoked.
  private async revokeFamily(familyId: string) {
    await this.db.transaction(async (m) => {
      await m.query(
        'SELECT 1 FROM sessions WHERE family_id = $1 ORDER BY created_at, id FOR UPDATE',
        [familyId],
      );
      await m.query(
        'UPDATE sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
        [familyId],
      );
    });
  }

  private async issue(
    user: User,
    familyId: string,
    userAgent?: string,
    manager: EntityManager = this.db.manager,
    id: string = randomUUID(),
  ) {
    const ttl = this.config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true });
    const days = this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
    const payload: AccessTokenPayload = { sub: user.id, role: user.role };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: ttl });
    const refreshToken = randomBytes(32).toString('base64url');
    await manager.insert(Session, {
      id,
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + days * 86_400_000),
      userAgent: userAgent?.slice(0, 200) ?? null,
    });
    return {
      accessToken,
      accessTokenExpiresIn: ttl,
      refreshToken,
      user: toMe(user),
    };
  }
}
