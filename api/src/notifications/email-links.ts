import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.validation';
import { SignedTokens } from './signed-tokens';

// The "stop invitation emails" link in every invitation email. It has to
// work without signing in: people unsubscribe from a mail app, often on a
// device where they aren't signed in, and mail apps call it themselves for
// one-tap unsubscribe (RFC 8058). So the link carries an HMAC of the user id
// instead of a session. It can only turn that person's invitation emails off.
@Injectable()
export class EmailLinks extends SignedTokens {
  private readonly base: string;

  constructor(config: ConfigService<AppConfig, true>) {
    super(config.get('JWT_SECRET', { infer: true }), 'email-unsubscribe-v1');
    this.base = config
      .get('API_PUBLIC_URL', { infer: true })
      .replace(/\/$/, '');
  }

  unsubscribeUrl(userId: string): string {
    return `${this.base}/emails/unsubscribe?u=${userId}&t=${this.sign(userId)}`;
  }
}
