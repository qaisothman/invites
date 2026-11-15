import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.validation';
import { SignedTokens } from './signed-tokens';

// A signed, per-notification token carried in the push itself.
//
// The phone confirms delivery from a background task that may run in a fresh
// JS runtime with no access token. Refreshing a session there would race the
// app's own refresh (and rotating refresh tokens punish that race). Instead
// the push carries proof that this phone received this notification: an HMAC
// of its id. The token can only mark that one notification delivered, so a
// leaked token is worth nothing else.
@Injectable()
export class AckTokens extends SignedTokens {
  constructor(config: ConfigService<AppConfig, true>) {
    super(config.get('JWT_SECRET', { infer: true }), 'push-ack-v1');
  }
}
