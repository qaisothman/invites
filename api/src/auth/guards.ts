import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import { UserRole } from '../users/user.entity';
import type { AccessTokenPayload } from './auth-user';
import { IS_PUBLIC, ROLES } from './decorators';

// Global guards run in the order they are registered in AppModule:
// JwtAuthGuard (who are you?) -> RolesGuard (may you?) -> UserThrottlerGuard
// (how often?). The throttler comes last so it can count per user, not per IP.

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const [scheme, token] = (req.header('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException({
        code: 'missing_token',
        message: 'Sign in required',
      });
    }
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
      req.user = { id: payload.sub, role: payload.role };
      return true;
    } catch {
      // Expired and forged tokens get the same answer; the client refreshes.
      throw new UnauthorizedException({
        code: 'invalid_token',
        message: 'Token is invalid or expired',
      });
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (user && roles.includes(user.role)) return true;
    throw new ForbiddenException({ code: 'forbidden', message: 'Not allowed' });
  }
}

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const r = req as Request;
    return Promise.resolve(r.user ? `user:${r.user.id}` : `ip:${r.ip}`);
  }
}
