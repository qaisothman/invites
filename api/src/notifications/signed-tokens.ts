import { createHmac, timingSafeEqual } from 'node:crypto';

// An HMAC of a value, under a key derived for one purpose only, never the
// JWT key itself: a token signed for one purpose is worthless for another.
export class SignedTokens {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    this.key = createHmac('sha256', secret).update(purpose).digest();
  }

  sign(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }

  verify(value: string, token: string): boolean {
    const expected = Buffer.from(this.sign(value));
    const given = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
