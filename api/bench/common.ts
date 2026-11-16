import { cpus, totalmem } from 'node:os';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { typeOrmOptions } from '../src/database/typeorm.options';

// Benchmarks use their own database, migrated to the current schema, so
// they never touch development or test data.
export async function benchDatabase(): Promise<string> {
  const url =
    process.env.BENCH_DATABASE_URL ??
    'postgres://localhost:5432/nest_invites_bench';
  const admin = new Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  const name = new URL(url).pathname.slice(1);
  const exists = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
  );
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const db = new DataSource(typeOrmOptions(url, 1));
  await db.initialize();
  await db.runMigrations();
  await db.destroy();
  return url;
}

export async function machine(db: Client) {
  const pg = (await db.query('SHOW server_version')).rows[0]
    .server_version as string;
  return {
    cpu: cpus()[0].model,
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    postgres: pg,
    note: 'Laptop, Postgres on the same machine, default Postgres settings (shared_buffers 128MB).',
    date: new Date().toISOString(),
  };
}
