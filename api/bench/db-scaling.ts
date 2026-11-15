/* eslint-disable no-console */
// How the hot queries behave as the tables grow.
//
//   npm run bench:db
//
// Grows `invitations` and `notifications` in steps (one notification per
// invitation, spread over 90 days, like production would accumulate) and
// times each hot query at each size: median of 15 runs, client-side.
// Writes docs/benchmarks/db-scaling.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { FUNNEL_SQL } from '../src/invitations/funnel.sql';
import { benchDatabase, machine } from './common';

const SIZES = [10_000, 100_000, 500_000, 2_000_000];
const USERS = 100_000;
const RUNS = 15;

async function main() {
  const db = new Client({ connectionString: await benchDatabase() });
  await db.connect();
  await db.query(
    'TRUNCATE users, devices, invitations, notifications, push_tickets, sessions CASCADE',
  );
  console.log(`seeding ${USERS} users`);
  await db.query(
    `INSERT INTO users (email, display_name, password_hash)
     SELECT 'u' || g || '@bench.test', 'User ' || g, 'x'
     FROM generate_series(1, $1) g`,
    [USERS],
  );
  await db.query(
    `CREATE TEMP TABLE u AS SELECT id, row_number() OVER () AS rn FROM users`,
  );
  await db.query(`CREATE INDEX ON u (rn)`);

  const results: Record<string, unknown>[] = [];
  let have = 0;
  for (const size of SIZES) {
    const add = size - have;
    console.log(`growing to ${size} invitations + notifications`);
    const t0 = Date.now();
    await seed(db, have, add);
    have = size;
    await db.query('VACUUM ANALYZE invitations');
    await db.query('VACUUM ANALYZE notifications');
    const seedSeconds = (Date.now() - t0) / 1000;

    // 1,000 notifications due right now: what the dispatcher competes over.
    await db.query(
      `UPDATE notifications SET status = 'sent' WHERE status = 'pending'`,
    );
    await db.query(
      `UPDATE notifications SET status = 'pending', next_attempt_at = now() - interval '1 second'
       WHERE id IN (SELECT id FROM notifications ORDER BY created_at DESC LIMIT 1000)`,
    );
    // The invitation emailer's work: the 1,000 newest invitations reached no
    // phone and are still open, and 2% of everything older than an
    // invitation's lifetime was unreachable and never emailed (cancelled or
    // expired first), which the emailer's scan must not wade through.
    await db.query(`DROP TABLE IF EXISTS candidates`);
    await db.query(
      `CREATE TEMP TABLE candidates AS
       SELECT id, (data->>'invitationId')::uuid AS invitation_id FROM notifications
       WHERE status = 'delivered'
         AND created_at BETWEEN now() - interval '13 days' AND now() - interval '1 hour'
       ORDER BY random() LIMIT 1000`,
    );
    await db.query(
      `UPDATE notifications SET status = 'unreachable'
       WHERE id IN (SELECT id FROM candidates)
          OR (status = 'delivered' AND created_at < now() - interval '14 days' AND random() < 0.02)`,
    );
    await db.query(
      `UPDATE invitations SET status = 'pending', opened_at = NULL, responded_at = NULL,
              expires_at = now() + interval '7 days'
       WHERE id IN (SELECT invitation_id FROM candidates)`,
    );
    await db.query('ANALYZE notifications');
    await db.query('ANALYZE invitations');

    const someUser = (
      await db.query(`SELECT invitee_id FROM invitations LIMIT 1`)
    ).rows[0].invitee_id as string;
    const row: Record<string, unknown> = { rows: size, seedSeconds };
    row.claimWithIndexMs = await time(db, CLAIM, true);
    row.claimWithoutIndexMs = await time(
      db,
      CLAIM,
      true,
      'DROP INDEX notifications_due_idx',
    );
    row.emailScanMs = await time(db, EMAIL_SCAN);
    row.inboxPageMs = await time(db, INBOX, false, undefined, [someUser]);
    row.funnelOneDayMs = await time(db, FUNNEL_SQL, false, undefined, since(1));
    row.funnelThirtyDaysMs = await time(
      db,
      FUNNEL_SQL,
      false,
      undefined,
      since(30),
    );
    row.tableMb = Number(
      (
        await db.query(
          `SELECT pg_total_relation_size('notifications') / 1048576.0 AS mb`,
        )
      ).rows[0].mb,
    ).toFixed(0);
    row.dueIndexKb = Number(
      (
        await db.query(
          `SELECT pg_relation_size('notifications_due_idx') / 1024.0 AS kb`,
        )
      ).rows[0].kb,
    ).toFixed(0);
    console.log(row);
    results.push(row);
  }

  const out = join(__dirname, '..', '..', 'docs', 'benchmarks');
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'db-scaling.json'),
    JSON.stringify(
      { machine: await machine(db), runsPerQuery: RUNS, results },
      null,
      2,
    ),
  );
  await db.end();
}

// Adds `n` invitations, each with its invitation notification, created over
// the last 90 days, with plausible outcomes.
async function seed(db: Client, offset: number, n: number) {
  for (let start = 0; start < n; start += 250_000) {
    const count = Math.min(250_000, n - start);
    const base = offset + start;
    await db.query(
      `WITH g AS (
         SELECT s AS g, now() - random() * interval '90 days' AS at
         FROM generate_series($1::bigint + 1, $1::bigint + $2) s
       ), ins AS (
         INSERT INTO invitations (inviter_id, invitee_id, status, expires_at, opened_at, responded_at, created_at)
         SELECT a.id, b.id,
                (CASE WHEN g.g % 10 < 5 THEN 'accepted' WHEN g.g % 10 < 7 THEN 'declined' ELSE 'expired' END)::invitations_status_enum,
                g.at + interval '14 days',
                CASE WHEN g.g % 10 < 8 THEN g.at + interval '10 minutes' END,
                CASE WHEN g.g % 10 < 7 THEN g.at + interval '1 hour' END,
                g.at
         FROM g
         JOIN u a ON a.rn = (g.g % ${USERS}) + 1
         JOIN u b ON b.rn = ((g.g + 1 + g.g % 997) % ${USERS}) + 1
         RETURNING id, invitee_id, created_at
       )
       INSERT INTO notifications (user_id, type, title, body, data, dedupe_key, status, attempts,
                                  next_attempt_at, sent_at, delivered_at, created_at)
       SELECT invitee_id, 'invitation.received', 'Someone invited you', 'Tap to see the invitation',
              jsonb_build_object('invitationId', id), 'invitation:' || id || ':received', 'delivered', 1,
              created_at, created_at + interval '2 seconds', created_at + interval '4 seconds', created_at
       FROM ins`,
      [base, count],
    );
  }
}

const CLAIM = `
  WITH due AS (
    SELECT id FROM notifications
    WHERE status = 'pending' AND next_attempt_at <= now()
    ORDER BY next_attempt_at LIMIT 200 FOR UPDATE SKIP LOCKED)
  UPDATE notifications n SET status = 'sending', attempts = n.attempts + 1,
    locked_until = now() + interval '60 seconds'
  FROM due WHERE n.id = due.id RETURNING n.id`;

// The invitation emailer's first query: who has an invitation no phone of
// theirs could show (InvitationEmailer.runOnce).
const EMAIL_SCAN = `
  SELECT DISTINCT n.user_id
  FROM notifications n, invitations i, users u
  WHERE n.email_status = 'none'
    AND n.status IN ('unreachable', 'failed')
    AND n.type = ANY('{invitation.received}')
    AND n.created_at <= now() - interval '900 seconds'
    AND n.created_at > now() - interval '14 days'
    AND i.id = (n.data->>'invitationId')::uuid
    AND i.status = 'pending' AND i.expires_at > now() AND i.opened_at IS NULL
    AND u.id = n.user_id
    AND (NOT u.invitation_emails OR u.last_invitation_email_at IS NULL
         OR u.last_invitation_email_at <= now() - interval '24 hours')
  LIMIT 100`;

const INBOX = `
  SELECT * FROM notifications WHERE user_id = $1
  ORDER BY created_at DESC, id DESC LIMIT 21`;

// The funnel report's own query (InvitationsService.funnel), over the last
// `days` days.
const since = (days: number) => [
  new Date(Date.now() - days * 86_400_000),
  new Date(),
];

// Median wall time of `sql`. Writes run inside a transaction that is rolled
// back, so every run sees the same data. `prep` runs first in the same
// transaction (Postgres DDL is transactional, so DROP INDEX is undone too).
async function time(
  db: Client,
  sql: string,
  rollback = false,
  prep?: string,
  params: unknown[] = [],
) {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await db.query('BEGIN');
    if (prep) await db.query(prep);
    const t = process.hrtime.bigint();
    await db.query(sql, params);
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    await db.query(rollback || prep ? 'ROLLBACK' : 'COMMIT');
  }
  samples.sort((a, b) => a - b);
  return Number(samples[Math.floor(samples.length / 2)].toFixed(2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
