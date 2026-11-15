import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';

// One definition shared by the running app (TypeOrmModule) and the migration
// CLI (data-source.ts), so the two can never disagree about entities or paths.
export function typeOrmOptions(
  databaseUrl: string,
  poolSize = 10,
  statementTimeoutMs = 15_000,
): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    namingStrategy: new SnakeNamingStrategy(),
    // gen_random_uuid() is built into Postgres 13+; no extension needed.
    uuidExtension: 'pgcrypto',
    // Schema changes only ever ship as reviewed migrations.
    synchronize: false,
    migrationsRun: false,
    // One transaction per migration, so a migration can opt out
    // (transaction = false) for CREATE INDEX CONCURRENTLY.
    migrationsTransactionMode: 'each',
    extra: {
      max: poolSize,
      // Fail fast instead of queueing forever when the pool is exhausted.
      connectionTimeoutMillis: 5000,
      // A runaway query can't hold a connection for more than 15 seconds
      // (0, no limit, for the migration CLI).
      statement_timeout: statementTimeoutMs,
    },
  };
}
