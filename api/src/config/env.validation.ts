import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

// 'true'/'1' and 'false'/'0' only. Anything else is left as it is, so
// @IsBoolean rejects it instead of reading a typo as false.
const toBool = ({ value }: { value: unknown }) => {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return value;
};

// Every setting the app reads, checked once at boot. A missing or malformed
// variable stops the process before it serves a request, instead of failing
// later on the first request that needs it. Env values are always strings, so
// numbers go through @Type and booleans through toBool before the checks run.
export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  // Proxies in front of the API that set X-Forwarded-For: 0 when clients
  // connect directly (locally, in compose), 1 behind one load balancer. Too
  // high lets a client pick its own rate-limit key; too low makes every
  // client share the proxy's. Required in production, where 0 is a choice
  // to make on purpose, not a default to fall into.
  @Type(() => Number)
  @IsInt()
  @Min(0)
  TRUST_PROXY_HOPS: number = 0;

  // One JSON log line per request. Tests and benchmarks turn it off.
  @Transform(toBool)
  @IsBoolean()
  LOG_REQUESTS: boolean = true;

  // ---- Database
  @IsString()
  DATABASE_URL!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  DB_POOL_SIZE: number = 10;

  // ---- Auth
  @IsString()
  @MinLength(32)
  JWT_SECRET!: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  ACCESS_TOKEN_TTL_SECONDS: number = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  REFRESH_TOKEN_TTL_DAYS: number = 30;

  // How long the previous refresh token is still accepted after a rotation,
  // as long as its successor hasn't been used. Covers a refresh response lost
  // on a flaky network; 0 turns it off. See ADR 0005.
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  REFRESH_GRACE_SECONDS: number = 10;

  // scrypt cost as log2(N): 15 means N = 32768, about 32 MB of memory per
  // hash, which is what makes guessing expensive on GPUs.
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(17)
  PASSWORD_HASH_COST: number = 15;

  // ---- Rate limits
  @Type(() => Number)
  @IsInt()
  @Min(1)
  THROTTLE_PER_MINUTE: number = 120;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  AUTH_PER_MINUTE: number = 10;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  INVITES_PER_HOUR: number = 30;

  // ---- Invitations
  @Type(() => Number)
  @IsInt()
  @Min(1)
  INVITE_TTL_DAYS: number = 14;

  @IsString()
  APP_LINK_BASE: string = 'https://invites.example.com';

  // ---- Background workers. The API and the workers ship as one image; a
  // deployment turns the workers on or off with this flag.
  @Transform(toBool)
  @IsBoolean()
  WORKERS_ENABLED: boolean = true;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  DISPATCH_BATCH_SIZE: number = 200;

  @Type(() => Number)
  @IsInt()
  @Min(50)
  DISPATCH_INTERVAL_MS: number = 1000;

  // Attempts for a push that fails in transport (network, timeout, Expo 429
  // or 5xx). With the 5 s doubling backoff, 8 attempts span 5 to 11 minutes.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PUSH_MAX_ATTEMPTS: number = 8;

  // How long a push failing on the provider's side (credentials, Apple or
  // Google rate limits) keeps being retried; those don't use up attempts.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PUSH_GIVE_UP_AFTER_HOURS: number = 24;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  RECEIPT_DELAY_SECONDS: number = 900;

  // ---- Providers
  @IsIn(['expo', 'fake'])
  PUSH_DRIVER: 'expo' | 'fake' = 'expo';

  @IsOptional()
  @IsString()
  EXPO_ACCESS_TOKEN?: string;

  // Fake push latency, used by the load tests to stand in for Expo's.
  @Type(() => Number)
  @IsInt()
  @Min(0)
  FAKE_PUSH_LATENCY_MS: number = 0;

  // No email provider is connected yet: 'log' writes each email to the log.
  // docs/08-sending-real-email.md lists what a real one needs.
  @IsIn(['log', 'fake'])
  EMAIL_DRIVER: 'log' | 'fake' = 'log';

  // The From address every invitation email carries.
  @IsString()
  EMAIL_FROM: string = 'Invites <invitations@notify.invites.example.com>';
}

export function validateEnv(config: Record<string, unknown>) {
  const env = plainToInstance(EnvironmentVariables, config);
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const problems = errors
      .map(
        (e) =>
          `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  if (env.NODE_ENV === 'production' && env.PUSH_DRIVER === 'fake') {
    throw new Error('Invalid environment: PUSH_DRIVER=fake in production');
  }
  if (env.NODE_ENV === 'production' && env.EMAIL_DRIVER === 'fake') {
    throw new Error('Invalid environment: EMAIL_DRIVER=fake in production');
  }
  if (
    env.NODE_ENV === 'production' &&
    (config.TRUST_PROXY_HOPS === undefined || config.TRUST_PROXY_HOPS === '')
  ) {
    throw new Error(
      'Invalid environment: TRUST_PROXY_HOPS must be set in production (0 when clients connect directly)',
    );
  }
  return env;
}

export type AppConfig = EnvironmentVariables;
