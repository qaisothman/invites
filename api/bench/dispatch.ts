/* eslint-disable no-console */
// How fast the real dispatcher drains a full outbox.
//
//   npm run bench:dispatch
//
// Each scenario: N users with one device each, N notifications due now. It
// boots the real application context (the same code the worker runs, with the
// fake push sender adding Expo-like latency), runs W dispatch loops at once,
// and times how long the outbox takes to empty. Writes
// docs/benchmarks/dispatch.json.
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { benchDatabase, machine } from './common';

interface Scenario {
  group: string;
  workers: number;
  batch: number;
  latencyMs: number;
  n: number;
}

const scenarios: Scenario[] = [
  // Scaling out: more dispatch loops, Expo-like latency (150 ms per request).
  ...[1, 2, 4, 8, 16].map((workers) => ({
    group: 'workers',
    workers,
    batch: 200,
    latencyMs: 150,
    n: 20_000,
  })),
  // Batch size, at 4 loops.
  ...[50, 100, 200, 500].map((batch) => ({
    group: 'batch',
    workers: 4,
    batch,
    latencyMs: 150,
    n: 20_000,
  })),
  // How much the provider's speed matters, at 4 loops.
  ...[0, 50, 500].map((latencyMs) => ({
    group: 'latency',
    workers: 4,
    batch: 200,
    latencyMs,
    n: 20_000,
  })),
];

async function main() {
  const url = await benchDatabase();
  const db = new Client({ connectionString: url });
  await db.connect();

  const results: Record<string, unknown>[] = [];
  for (const s of scenarios) {
    await seed(db, s.n);
    const app = await boot(url, s);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OutboxDispatcher } =
      require('../src/notifications/dispatcher') as typeof import('../src/notifications/dispatcher.js');
    const dispatcher = app.get(OutboxDispatcher);

    const t0 = process.hrtime.bigint();
    await Promise.all(
      Array.from({ length: s.workers }, async () => {
        while ((await dispatcher.runOnce()) > 0) {
          /* drain */
        }
      }),
    );
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    await app.close();

    const sent = Number(
      (
        await db.query(
          `SELECT count(*) FROM notifications WHERE status = 'sent'`,
        )
      ).rows[0].count,
    );
    const dupes = Number(
      (
        await db.query(
          `SELECT count(*) - count(DISTINCT notification_id) AS d FROM push_tickets`,
        )
      ).rows[0].d,
    );
    const row = {
      ...s,
      seconds: Number(seconds.toFixed(2)),
      perSecond: Math.round(sent / seconds),
      sent,
      duplicateSends: dupes,
    };
    console.log(row);
    results.push(row);
  }

  const out = join(__dirname, '..', '..', 'docs', 'benchmarks');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'dispatch.json'),
    JSON.stringify({ machine: await machine(db), results }, null, 2),
  );
  await db.end();
}

async function seed(db: Client, n: number) {
  await db.query(
    'TRUNCATE users, devices, invitations, notifications, push_tickets, sessions CASCADE',
  );
  await db.query(
    `WITH u AS (
       INSERT INTO users (email, display_name, password_hash)
       SELECT 'd' || g || '@bench.test', 'User ' || g, 'x' FROM generate_series(1, $1) g
       RETURNING id, email
     ), d AS (
       INSERT INTO devices (user_id, expo_push_token, platform)
       SELECT id, 'ExponentPushToken[' || email || ']', 'ios' FROM u
     )
     INSERT INTO notifications (user_id, type, title, body, dedupe_key)
     SELECT id, 'invitation.received', 'Someone invited you', 'Tap to see', 'bench:' || id FROM u`,
    [n],
  );
  await db.query('VACUUM ANALYZE notifications');
}

async function boot(
  url: string,
  s: Scenario,
): Promise<INestApplicationContext> {
  // Config is read once at boot, so each scenario gets a fresh context.
  Object.assign(process.env, {
    NODE_ENV: 'development',
    DATABASE_URL: url,
    JWT_SECRET: 'bench-secret-that-is-at-least-32-characters',
    WORKERS_ENABLED: 'false',
    PUSH_DRIVER: 'fake',
    FAKE_PUSH_LATENCY_MS: String(s.latencyMs),
    DISPATCH_BATCH_SIZE: String(s.batch),
    DB_POOL_SIZE: String(s.workers + 4),
    LOG_REQUESTS: 'false',
  });
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/src/')) delete require.cache[k];
  }
  // Fresh require so ConfigModule validates this scenario's environment.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } =
    require('../src/app.module') as typeof import('../src/app.module.js');
  return NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
