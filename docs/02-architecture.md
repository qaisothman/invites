# Architecture

## System context

```
 Inviter's phone ──HTTPS──▶ ┌──────────────┐        ┌──────────────┐
                            │  API (Nest)  │──SQL──▶│  PostgreSQL  │
 Invitee's phone ──HTTPS──▶ │  N instances │        │  primary (+  │
       ▲                    └──────────────┘        │  replica)    │
       │                                            └──────▲───────┘
       │                    ┌──────────────┐               │
       │                    │ Worker (Nest)│──SQL (claim)──┘
       │                    │  M instances │
  push │                    └──┬────────┬──┘
       │                       │        │
  ┌────┴─────┐   HTTPS   ┌─────▼───┐  ┌─▼──────────────┐
  │ APNs/FCM │◀──────────│  Expo   │  │ Email provider │──▶ invitee's inbox, when no
  └──────────┘           │  push   │  │ (log until set │    phone of theirs can show
                         └─────────┘  │ up, see 08)    │    the push
                                      └────────────────┘
```

The invitee's phone sends its device reports and its delivered and opened acks to the API over the same HTTPS arrow; the worker only makes outbound calls.

The same image runs as the **API** (`WORKERS_ENABLED=false`) and the **worker** (`WORKERS_ENABLED=true`). A one-off **migrate** job runs before each release. See [ADR 0001](adr/0001-modular-monolith.md).

## Modules

| Module | Owns | Exposes |
|---|---|---|
| `config` | Validated environment (fails at boot) | `AppConfig` |
| `auth` | `sessions`; JWT; global guards | register, login, refresh, logout; `@Public`, `@Roles`, `@CurrentUser` |
| `users` | `users` | `/users/me`, lookup by email |
| `devices` | `devices` | register (upsert) a phone with its notifications state, unregister; `reachableFor`, `disable` |
| `invitations` | `invitations` | create, list, get, accept, decline, cancel, expire; the funnel report |
| `notifications` | `notifications`, `push_tickets` | `enqueue` (outbox), acks, inbox, support trace, email unsubscribe; dispatcher, receipt poller, invitation emailer; push and email providers |
| `workers` | nothing | `WorkerRunner`: starts and gracefully stops the loops |
| `metrics` | nothing | Prometheus `/metrics` |

## A request, in order

`RequestIdMiddleware` (id, timing, log line) → guards in registration order: `JwtAuthGuard` (who are you?) → `RolesGuard` (may you?) → `UserThrottlerGuard` (how often?) → `ValidationPipe` (whitelist, forbid unknown fields, transform to DTO classes) → controller → service → TypeORM/SQL. Any exception → `HttpExceptionFilter` → `{ error: { code, message, details? }, requestId }`.

All of these are registered as `APP_*` providers in `AppModule`, not in `main.ts`, so tests get exactly the same pipeline.

## The invitation flow

```
App A          API                       Postgres                 Worker             Expo        App B
  │ POST /invitations                       │                        │                  │            │
  │──────────────▶│ BEGIN                   │                        │                  │            │
  │               │ INSERT invitation ─────▶│                        │                  │            │
  │               │ INSERT notification ───▶│ (pending, outbox)      │                  │            │
  │               │ COMMIT                  │                        │                  │            │
  │◀── 201 ───────│                         │                        │                  │            │
  │               │                         │◀─ claim (SKIP LOCKED) ─│ every 1 s,       │            │
  │               │                         │── rows (sending) ─────▶│ drains while full│            │
  │               │                         │                        │── send ─────────▶│            │
  │               │                         │                        │◀─ tickets ───────│── push ───▶│
  │               │                         │◀─ tickets, sent ───────│                  │            │
  │               │◀────────────── POST /notifications/:id/ack {token} (and /opened on tap) ──────────│
  │               │ status → delivered      │                        │                  │            │
  │               │                         │   +15 min: receipts ──▶│── getReceipts ──▶│            │
```

If no phone of B's can show the push, the worker marks it `unreachable` and sends nothing, and the invitation emailer takes over (below).

## Notification states

```
pending ──claim──▶ sending ──ok──▶ sent ──app ack──▶ delivered ──tap──▶ opened
   ▲                  │
   └── retry (backoff)┤ (outage, 429, 5xx: 8 transport attempts, about 5 to 11 min;
                      │   broken credentials, Apple or Google rate limits: until 24 h old,
                      │   using up no attempt; left unsent at the send deadline: a few s)
                      ├──▶ failed       (gave up, or every receipt of the latest send rejected)
                      ├──▶ unreachable  (no phone that can show it, or every token dead)
                      └──▶ withdrawn    (the invitation was cancelled or expired while it
                                         waited: nothing sent, nothing failed)

invitation seen in the app ──▶ opened, from any state (stops a queued push and the email)

failed / unreachable, invitation still open ──▶ invitation email (withdrawn never is)
  (email_status: none ─▶ pending ─▶ sent | failed, or none again to retry; none ─▶ opted_out)
```

## Reaching the invitee

Push is the channel; email covers the invitees push can't reach. Two halves: the phone says what it can show, and the server decides from that. See [ADR 0006](adr/0006-email-for-invitees-push-cannot-reach.md).

**On the phone:**

```
launch, or back to the foreground
        │
        ▼
read the permission (and, on Android, the Invitations channel)
        │
        ├──▶ POST /devices { expoPushToken, notifications }   on launch; then when it changes, or 15+ min since the last report
        │
        ├── allowed ────▶ nothing to show
        │
        ├── not_asked ──▶ inbox: "Turn on notifications…"  [Turn on] [Not now]
        │                      │ Turn on
        │                      ▼
        │                 OS prompt ── Allow ───────▶ registered as allowed
        │                      └────── Don't Allow ─▶ quiet for 7 days
        │
        └── off ────────▶ inbox: "Notifications are off…"  [Open Settings] [Not now]
                               │ Open Settings
                               ▼
                          system Settings ── back to the app ──▶ re-read, re-report, prompt gone

"Not now" quiets the prompt for 7 days. It never blocks anything: the app works without push.
```

**On the server:**

```
invitation ──▶ notification in the outbox
                     │ dispatcher
                     ▼
     any phone of the invitee's that can show it?
     (signed in · last report "allowed" · not an Android phone silent for 90 days)
        │ yes                                  │ no
        ▼                                      ▼
   push to each of them                   unreachable
        │ every attempt fails                  │
        ▼                                      │
      failed ──────────────────────────────────┤
                                               ▼
                   invitation emailer, every minute, in passes of 100 people
                         (again at once while a pass comes back full)
                                               │
           15 min old, and the invitation still pending, unexpired, unopened?
                                               │ yes
                                               ▼
                            invitation emails off? ── yes ──▶ opted_out (counted, nothing sent)
                                               │ no
                                               ▼
                         emailed in the last 24 h? ── yes ──▶ waits until 24 h after the last one
                                               │ no
                                               ▼
                     claim the person's day and their invitations: pending
                  (a claim unsettled after 10 minutes goes back to the queue)
                                               │
                                               ▼
                         one email with everything waiting ──▶ sent
                         (a refused send frees the person's day and is retried per
                          invitation 5, 10, 20 and 40 minutes later, 5 attempts in all)
```

The emailer reads only notifications younger than `INVITE_TTL_DAYS`: no older invitation can still be open, so its scan covers one invitation lifetime of the index however long the table grows. It sends outside the claiming transaction, so a slow provider holds no locks. A claim unsettled after 10 minutes belongs to a worker that died mid-send; it goes back to the queue with the person's day. A rare duplicate email is possible, a lost one isn't.

## Decisions

1. [One service, two roles](adr/0001-modular-monolith.md)
2. [Transactional outbox in Postgres](adr/0002-postgres-outbox.md)
3. [At-least-once delivery, confirmed by the app](adr/0003-at-least-once-delivery.md)
4. [Providers behind interfaces](adr/0004-providers-behind-interfaces.md)
5. [Short access tokens, rotating refresh tokens](adr/0005-auth-tokens.md)
6. [Email for invitees push can't reach](adr/0006-email-for-invitees-push-cannot-reach.md)
