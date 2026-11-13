import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';

// One definition shared by the running app (TypeOrmModule) and the migration
// CLI (data-source.ts), so the two can never disagree about entities or paths.
export function typeOrmOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    // Schema changes only ever ship as reviewed migrations.
    synchronize: false,
    migrationsRun: false,
  };
}
