# Scaling plan: from launch to 10 million members

Scale is planned from numbers, not guessed. This page turns users into load with stated assumptions, compares that load with what the [benchmarks](benchmarks/README.md) measured, and lists what changes at each stage and which metric says it's time.

## From users to load

| Assumption | Value | Why |
|---|---|---|
| Daily actives | 20% of monthly members | typical for a social app |
| Invitations per daily active | 0.5 a day | |
| Notifications per invitation | 1.5 | one to the invitee, plus one to the inviter for the half that are accepted |
| API requests per daily active | 60 a day | app opens, device reports, inbox, profile, acks |
| Peak hour | 15% of the day | evenings |
| Burst | 20 × the peak | a campaign, or "invite your contacts" going viral |

Peak per second = daily volume × 0.15 / 3,600.

| Members (monthly) | Invitations a day | Notifications at peak | Notifications in a burst | API requests at peak | New notification rows a year |
|---|---|---|---|---|---|
| 10,000 | 1,000 | 0.06/s | 1.3/s | 5/s | 0.55 M |
| 100,000 | 10,000 | 0.6/s | 13/s | 50/s | 5.5 M |
| 1,000,000 | 100,000 | 6/s | 125/s | 500/s | 55 M |
| 10,000,000 | 1,000,000 | 63/s | 1,250/s | 5,000/s | 550 M |

## Against the measured limits

Measured on one laptop (Apple M3 Max, Postgres 15 with default settings, one Node process). Production hardware differs; the shape of the curves is what carries over.

- **Dispatcher:** one dispatch loop sends about **1,020 a second** with 150 ms of simulated Expo latency per request; 4 loops about 4,000; 16 loops about 14,500. With no provider latency at all, 4 loops reach about 30,000 a second: that's the database-and-Node ceiling. Across 12 runs and 240,000 notifications, none was sent twice. Even one loop is faster than Expo allows (**600 notifications a second per project**), so the bottleneck is Expo's rate limit, not this code. Until a send limiter exists (stage 2), a burst above 600 a second gets 429s from Expo, which are retried with backoff (8 transport attempts over about 5 to 11 minutes, then the invitation email): correct, but slower and noisier than limiting up front.
- **Claim query:** about 2–3 ms at every table size from 10,000 to 2 million rows, thanks to the partial index. Without it: 4 ms, then 13, 56 and 211 ms; it grows with the table.
- **Invitation emailer's scan:** 1.2 ms at 10,000 rows and 7.1 ms at 2 million, where about 3,400 open invitations are waiting for an email; it reads only the last 14 days of its index.
- **API:** one Node process serves about 2,000 inbox pages or 2,300 invitation writes a second and about 9,000 profile reads, with p99 at most 121 ms at 100 connections. At the 10-million-member peak (5,000 requests a second) that's 3 to 6 instances with headroom. Login is the expensive request by design: 86 a second per process with scrypt on libuv's thread pool (`bcryptjs`, which hashes on the main thread, managed 3).
- **Funnel report:** 30 days of data took 0.65 seconds at 2 million rows, measured with a reduced form of the report's query (the same join and date range, 4 of its 15 aggregates), so read it as a lower bound; `npm run bench:db` times the report's own query ([benchmarks](benchmarks/README.md#1-hot-queries-as-the-tables-grow-db-scalingjson)). Fine as an admin report; it needs a daily rollup before 10 million rows.
- **Invitation emailer:** a designed limit, not a measured one. It sends one email at a time, in passes of 100 people, and goes again at once while a pass comes back full, so its rate is set by how fast the email provider answers. Extra workers don't add throughput: only one can claim a given person. Nobody gets more than one invitation email a day, and the email provider's own sending limits apply on top ([Sending real email](08-sending-real-email.md)).

## Stages

### Stage 0: launch (up to ~10,000 members)
- **Run:** 2 API instances (for availability, not load), 1 worker, managed Postgres with point-in-time recovery, Expo push, an email provider ([Sending real email](08-sending-real-email.md); until one is connected, `EMAIL_DRIVER=log` writes each email to the log).
- **Rate limits:** the counters are in memory, one set per instance, so two instances allow up to twice each limit. Set `INVITES_PER_HOUR`, `AUTH_PER_MINUTE` and `THROTTLE_PER_MINUTE` to half the intended value on each, and `TRUST_PROXY_HOPS=1` behind the load balancer, so the per-IP limits see the client's address.
- **Watch:** the funnel. At this size the risk is product, not infrastructure.

### Stage 1: up to ~100,000
- **Change:** the rate limiter's counters move to Redis (`@nest-lab/throttler-storage-redis`); in memory they're per instance, so 3 instances means 3× the limit. A read replica for the admin funnel and support trace.
- **Trigger:** a third API instance, or a limit that has to be exact.

### Stage 2: up to ~1,000,000
- **Change:**
  - Autoscale the API on CPU and the worker on `outbox_oldest_due_seconds`.
  - PgBouncer in transaction mode: connections = instances × pool size, and Postgres doesn't like thousands.
  - Partition `notifications` and `push_tickets` by month; drop or archive partitions past 13 months. This is a migration, not a switch: Postgres needs the partition key in every unique constraint, so the primary key, the `push_tickets` foreign key and the unique `dedupe_key` behind the idempotent enqueue all have to be reworked first. Until that pays for itself, the monthly archive job in the [data model](03-data-model.md#growth-and-retention) gives the same retention.
  - A daily funnel rollup table, so the report doesn't scan raw rows.
  - A token-bucket limiter in the dispatcher, shared through Redis, at about 500 sends a second (headroom under Expo's 600). The benchmark shows one loop already outruns Expo; the limiter turns bursts into a short, orderly queue, not 429s and retries.
  - The invitation emailer sends in parallel batches and claims people with `FOR UPDATE SKIP LOCKED`, so extra workers add throughput.
  - OpenTelemetry traces across API, worker and Expo calls.
- **Triggers:** p95 API latency over 300 ms at peak, more than 200 database connections, the funnel query over 1 second, bursts nearing 500 sends a second, `invitation_emails_oldest_due_seconds` climbing at peak.

### Stage 3: up to ~10,000,000
- **Change:**
  - Bursts reach ~1,250 notifications a second, past Expo's per-project limit. Send to APNs and FCM directly (HTTP/2, far higher limits) behind the same `PushSender` interface, with the app registering native device tokens; keep Expo for development builds.
  - Move from polling the outbox to a log: either Postgres logical replication (Debezium) into Kafka or SQS, or a relay that reads the outbox and publishes. The notification module becomes its own service, as ADR 0001 allows.
  - Analytics events stream to a warehouse (BigQuery or ClickHouse); the funnel stops touching the production database.
  - Multi-AZ everything, regional read replicas if members are global.
- **Triggers:** sustained sends above 400 a second, outbox lag during bursts over 2 minutes, the primary over 60% CPU at peak.

## What not to do early

- Microservices, Kafka or Kubernetes operators at stage 0. Each is the right answer at stage 3 and a tax on a small team before then.
- Sharding. One well-indexed Postgres with partitions and replicas carries this product past 10 million members; the measured hot queries are flat in table size.
