import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
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
