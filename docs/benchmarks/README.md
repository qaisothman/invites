# Benchmarks

All numbers were measured on one laptop: Apple M3 Max (14 cores, 36 GB), Node 24, Postgres 15 with default settings (`shared_buffers` 128 MB), the client, the API and the database on the same machine. Production hardware differs; the **shapes** are what carry over. Raw results are the JSON files in this folder. Reproduce as in [Run and test it locally](../00-run-and-test-locally.md#4-optional), which sets `BENCH_DATABASE_URL`; each benchmark creates and migrates its own database. That guide's Postgres is 16 in Docker, so expect different absolute figures from these. `http-bcryptjs.json` is a one-off run of the same HTTP benchmark with password hashing switched to `bcryptjs` at cost 12, for comparison.

## 1. Hot queries as the tables grow (`db-scaling.json`)

`invitations` and `notifications` grow from 10,000 to 2,000,000 rows (one notification per invitation, spread over 90 days), with 1,000 notifications due at each size. At each size, up to 1,000 more recent invitations reached no phone and are still open (the invitation emailer's work; about 440 at 10,000 rows, 1,000 at each later size), and 2% of notifications older than an invitation's 14-day lifetime were left unreachable and never emailed. Median of 15 runs.

The claim, email scan, notifications page and table size columns time the queries the service runs. The two funnel columns were measured with a reduced form of the report's query: the same join and date range, 4 of its 15 aggregates. Read them as a lower bound for the full report; `npm run bench:db` times the report's own query (`FUNNEL_SQL`), and a new run replaces them.

| Rows | Claim 200, partial index | Claim 200, no index | Email scan | Notifications page | Funnel, 1 day | Funnel, 30 days | Table size |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 3.1 ms | 3.8 ms | 1.2 ms | 0.27 ms | 0.34 ms | 3.4 ms | 8 MB |
| 100,000 | 2.4 ms | 13.0 ms | 4.0 ms | 0.30 ms | 11.6 ms | 30.1 ms | 53 MB |
| 500,000 | 2.0 ms | 56.5 ms | 5.1 ms | 0.25 ms | 11.2 ms | 164.3 ms | 255 MB |
| 2,000,000 | 2.3 ms | 210.5 ms | 7.1 ms | 0.29 ms | 80.8 ms | 650.8 ms | 1,008 MB |

**Read it as:** the dispatcher's claim is flat because `notifications_due_idx` only covers rows waiting to be sent: 40 KB at 2 million rows. Without it, the claim scans the table and grows linearly (92× slower at 2 million). The invitation emailer's scan reads only the last 14 days of `notifications_email_due_idx`, so the old leftovers never enter it: 1.2 ms at 10,000 rows and 7.1 ms at 2 million, where about 3,400 open invitations are waiting for an email. The 30-day funnel grows with the data; it's an admin report, and it moves to a daily rollup before 10 million rows ([scaling plan](../04-scaling-plan.md), stage 2).

## 2. Dispatcher throughput (`dispatch.json`)

The real `OutboxDispatcher` drains 20,000 due notifications (one device each) with the fake push sender adding latency the way Expo's requests would (100 messages per request, 4 requests in flight).

| Scenario | Loops | Batch | Provider latency | Per second | Sent twice |
|---|---:|---:|---:|---:|---:|
| scale out | 1 | 200 | 150 ms | 1,021 | 0 |
|  | 2 | 200 | 150 ms | 2,027 | 0 |
|  | 4 | 200 | 150 ms | 4,055 | 0 |
|  | 8 | 200 | 150 ms | 7,798 | 0 |
|  | 16 | 200 | 150 ms | 14,480 | 0 |
| batch size | 4 | 50 | 150 ms | 1,203 | 0 |
|  | 4 | 100 | 150 ms | 2,298 | 0 |
|  | 4 | 200 | 150 ms | 4,179 | 0 |
|  | 4 | 500 | 150 ms | 5,403 | 0 |
| provider speed | 4 | 200 | 0 ms | 29,974 | 0 |
|  | 4 | 200 | 50 ms | 9,725 | 0 |
|  | 4 | 200 | 500 ms | 1,452 | 0 |

**Read it as:** throughput scales almost linearly with loops because the work is waiting on the provider, and `SKIP LOCKED` lets loops claim without blocking each other. 240,000 notifications across 12 runs, none sent twice. With zero provider latency, 4 loops reach about 30,000 a second: the database-and-Node ceiling on this machine. **Even one loop is faster than Expo's documented limit of 600 notifications a second per project**, so the production bottleneck is Expo, which is why the scaling plan adds a send limiter and, at the largest stage, direct APNs/FCM.

## 3. One API process under load (`http.json`)

The compiled API (workers off, as in production) against 10,000 users who have each received 30 invitations. autocannon, 10 seconds per run. Every authenticated endpoint is called with a real JWT; no request failed.

| Endpoint | Connections | Per second | p50 ms | p90 ms | p99 ms | Non-2xx |
|---|---:|---:|---:|---:|---:|---:|
| GET /health/ready | 10 | 19,701 | 0 | 0 | 1 | 0 |
| GET /health/ready | 50 | 18,763 | 2 | 3 | 4 | 0 |
| GET /health/ready | 100 | 17,577 | 5 | 6 | 8 | 0 |
| GET /users/me | 10 | 9,364 | 0 | 1 | 2 | 0 |
| GET /users/me | 50 | 8,965 | 5 | 6 | 9 | 0 |
| GET /users/me | 100 | 8,716 | 11 | 12 | 14 | 0 |
| GET /invitations (inbox page) | 10 | 2,035 | 4 | 6 | 7 | 0 |
| GET /invitations (inbox page) | 50 | 2,073 | 23 | 26 | 29 | 0 |
| GET /invitations (inbox page) | 100 | 2,036 | 48 | 51 | 60 | 0 |
| POST /invitations | 10 | 2,304 | 4 | 5 | 8 | 0 |
| POST /invitations | 50 | 2,351 | 20 | 22 | 56 | 0 |
| POST /invitations | 100 | 2,306 | 41 | 45 | 121 | 0 |
| POST /auth/login (scrypt, cost 15) | 10 | 86 | 119 | 135 | 155 | 0 |

**Read it as:** one Node process serves about 2,000 inbox pages or 2,300 invitation writes a second (each write is a transaction with an outbox insert) and about 9,000 authenticated profile reads. Latency grows with connections while throughput stays flat: the process is saturated, which is the signal to add instances, not to tune.

### Login: scrypt against bcryptjs

Node's built-in `crypto.scrypt` (N = 2^15, about 32 MB per hash) runs on libuv's thread pool: **86 logins a second, p50 119 ms, p99 155 ms** with 10 concurrent logins, a deliberately slow, memory-hard hash (OWASP lists scrypt alongside bcrypt and Argon2; cost 15 with p = 1 is the demo default, below OWASP's minimum, see [ADR 0005](../adr/0005-auth-tokens.md#trade-offs)). `bcryptjs` at cost 12, measured for comparison (`http-bcryptjs.json`), managed **3 logins a second, p50 2,534 ms, p99 3,168 ms**: it hashes in JavaScript on the main thread, so logins queue behind each other and block every other request on the process. The API uses scrypt; see [ADR 0005](../adr/0005-auth-tokens.md).

The two runs were on the same laptop while other work was running, so throughput on the other endpoints differs by up to about 12% between them, and tail latency by more (POST /invitations p99 at 50 connections: 56 ms in one run, 27 ms in the other).
