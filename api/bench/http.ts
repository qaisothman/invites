/* eslint-disable no-console */
// HTTP load test of one API process.
//
//   npm run build && npm run bench:http
//
// Starts the compiled API (workers off, as in production) against a seeded
// database, then drives each endpoint with autocannon at 10, 50 and 100
// concurrent connections for 10 seconds each. Writes docs/benchmarks/http.json.
import autocannon from 'autocannon';
import { ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sign } from 'jsonwebtoken';
import { Client } from 'pg';
import { benchDatabase, machine } from './common';

const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'bench-secret-that-is-at-least-32-characters';
const USERS = 10_000;
const DURATION = 10;

async function main() {
  const url = await benchDatabase();
  const db = new Client({ connectionString: url });
  await db.connect();
  const users = await seed(db);
  const tokens = users.map((u) =>
    sign({ sub: u.id, role: 'member' }, SECRET, { expiresIn: 3600 }),
  );
  const bearer = (i: number) => ({
    authorization: `Bearer ${tokens[i % tokens.length]}`,
  });

  const server = await start(url);
  const results: Record<string, unknown>[] = [];
  try {
    let counter = 0;
    const scenarios: {
      name: string;
      connections: number[];
      request: () => autocannon.Request;
    }[] = [
      {
        name: 'GET /health/ready',
        connections: [10, 50, 100],
        request: () => ({ method: 'GET', path: '/health/ready' }),
      },
      {
        name: 'GET /users/me',
        connections: [10, 50, 100],
        request: () => ({
          method: 'GET',
          path: '/users/me',
          headers: bearer(counter++),
        }),
      },
      {
        name: 'GET /invitations (inbox page)',
        connections: [10, 50, 100],
        request: () => ({
          method: 'GET',
          path: '/invitations?box=received&limit=20',
          headers: bearer(counter++),
        }),
      },
      {
        name: 'POST /invitations',
        connections: [10, 50, 100],
        request: () => {
          // A different (inviter, invitee) pair every time, so no 409s.
          const i = counter++;
          const inviter = i % USERS;
          const invitee = (inviter + 1 + Math.floor(i / USERS)) % USERS;
          return {
            method: 'POST',
            path: '/invitations',
            headers: { ...bearer(inviter), 'content-type': 'application/json' },
            body: JSON.stringify({ inviteeId: users[invitee].id }),
          };
        },
      },
      {
        name: 'POST /auth/login (scrypt, cost 15)',
        connections: [10],
        request: () => ({
          method: 'POST',
          path: '/auth/login',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: users[counter++ % 100].email,
            password: 'correct horse battery',
          }),
        }),
      },
    ];

    for (const s of scenarios) {
      for (const connections of s.connections) {
        const r = await autocannon({
          url: BASE,
          connections,
          duration: DURATION,
          requests: [{ setupRequest: (req) => ({ ...req, ...s.request() }) }],
        });
        const row = {
          endpoint: s.name,
          connections,
          requestsPerSecond: Math.round(r.requests.average),
          p50ms: r.latency.p50,
          p90ms: r.latency.p90,
          p99ms: r.latency.p99,
          non2xx: r.non2xx,
          errors: r.errors,
        };
        console.log(row);
        results.push(row);
      }
    }
  } finally {
    server.kill('SIGTERM');
  }

  const out = join(__dirname, '..', '..', 'docs', 'benchmarks');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'http.json'),
    JSON.stringify(
      {
        machine: await machine(db),
        process: 'one Node process, DB pool 20',
        durationSeconds: DURATION,
        results,
      },
      null,
      2,
    ),
  );
  await db.end();
}

// 10,000 users, each with 30 received invitations (so the inbox page is a
// real query) and a real password hash; the login test signs in as the first 100.
async function seed(db: Client) {
  console.log('seeding');
  await db.query(
    'TRUNCATE users, devices, invitations, notifications, push_tickets, sessions CASCADE',
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hashPassword } =
    require('../src/auth/password') as typeof import('../src/auth/password.js');
  const hash = await hashPassword('correct horse battery', 15);
  await db.query(
    `INSERT INTO users (email, display_name, password_hash)
     SELECT 'h' || g || '@bench.test', 'User ' || g, $2 FROM generate_series(1, $1) g`,
    [USERS, hash],
  );
  await db.query(
    `CREATE TEMP TABLE u AS SELECT id, row_number() OVER () AS rn FROM users`,
  );
  await db.query(
    `INSERT INTO invitations (inviter_id, invitee_id, status, expires_at, created_at)
     SELECT a.id, b.id, 'accepted', now() + interval '14 days', now() - random() * interval '30 days'
     FROM generate_series(1, $1 * 30) g
     JOIN u a ON a.rn = (g % $1) + 1
     JOIN u b ON b.rn = ((g + 1 + g / $1) % $1) + 1`,
    [USERS],
  );
  await db.query('VACUUM ANALYZE');
  const rows = await db.query(`SELECT id, email FROM users ORDER BY email`);
  return rows.rows as { id: string; email: string }[];
}

async function start(url: string): Promise<ChildProcess> {
  const child = spawn('node', ['dist/main'], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      DATABASE_URL: url,
      DB_POOL_SIZE: '20',
      JWT_SECRET: SECRET,
      WORKERS_ENABLED: 'false',
      PUSH_DRIVER: 'fake',
      LOG_REQUESTS: 'false',
      THROTTLE_PER_MINUTE: '100000000',
      AUTH_PER_MINUTE: '100000000',
      INVITES_PER_HOUR: '100000000',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health/ready`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('API did not start');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
