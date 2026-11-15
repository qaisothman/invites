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

  @IsString()
  @MinLength(32)
  JWT_SECRET!: string;
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
  return env;
}

export type AppConfig = EnvironmentVariables;
