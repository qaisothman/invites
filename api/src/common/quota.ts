import { ExecutionContext, SetMetadata } from '@nestjs/common';

// Named rate limits on top of the default per-minute one.
//   @Quota('auth')    sign-up and sign-in, per IP
//   @Quota('invites') creating invitations, per user per hour
// Each named throttler in AppModule skips every route not tagged with it.
export type QuotaName = 'auth' | 'invites';
const QUOTA = 'quota';

export const Quota = (name: QuotaName) => SetMetadata(QUOTA, name);

export const onlyFor =
  (name: QuotaName) =>
  (ctx: ExecutionContext): boolean => {
    const tagged =
      (Reflect.getMetadata(QUOTA, ctx.getHandler()) as QuotaName | undefined) ??
      (Reflect.getMetadata(QUOTA, ctx.getClass()) as QuotaName | undefined);
    return tagged !== name; // true = skip this throttler
  };
