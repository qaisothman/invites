# Data model

```
users 1───* devices            (push tokens, each with its notifications state;
                                 disabled, never deleted)
users 1───* sessions           (refresh tokens, hashed, grouped by family;
                                 replaced_by links each to its successor)
users 1───* invitations (as inviter)
users 1───* invitations (as invitee)
users 1───* notifications 1───* push_tickets *───1 devices
```

Every table uses UUID primary keys (`gen_random_uuid()`), `timestamptz` everywhere, snake_case columns, and foreign keys with `ON DELETE CASCADE` from `users` (deleting an account removes its data).

## Delivery state

| Column | Values | Meaning |
|---|---|---|
| `devices.notifications` | `allowed` (default), `not_asked`, `off` | The phone's last report. `not_asked`: the OS would still show its prompt. `off`: only Settings can turn them on. A report without the field counts as `allowed`. |
| `notifications.status` | `pending`, `sending`, `sent`, `delivered`, `opened`, `failed`, `unreachable`, `withdrawn` | The push. `unreachable`: no phone could show it, or every token was dead. `failed`: it gave up, or every receipt of its latest send was rejected. `withdrawn`: the invitation was cancelled or expired before the push went out; nothing was sent, and no email follows. |
| `notifications.attempts`, `transport_failures` | integers | `attempts`: claims so far; each result is written only under the claim number it came from, so a worker that lost its lease writes nothing. `transport_failures`: claims that ended in a network error, a timeout or an Expo 429 or 5xx; the `PUSH_MAX_ATTEMPTS`th (8) fails the push. Provider-side errors and a send cut off at its deadline add to neither limit. |
| `push_tickets.attempt` | integer | The claim (`notifications.attempts`) whose send made the ticket. The receipt poller re-queues a rate-limited push only on receipts of the latest send. |
| `notifications.email_status` | `none`, `pending`, `sent`, `failed`, `opted_out` | The invitation email. `pending`: claimed by a worker and being sent. With `email_at` (when it was claimed), `email_attempts` (claims so far; after a refusal the next one waits 5, 10, 20, then 40 minutes from `email_at`, and a refusal on the fifth gives up) and `email_error` (the last provider error, cleared once sent). |
| `users.invitation_emails` | boolean, default true | The Profile switch and the email's stop link. |
| `users.last_invitation_email_at` | timestamptz | When this person's last invitation email was claimed: what holds them to one a day. Set back to null when the provider refuses the send, when nothing of theirs was left to claim by the time their day was, or when a stalled claim goes back to the queue. The API never returns it. |

A phone can show a push when `disabled_at` is null, `notifications` is `allowed`, and it isn't an Android phone whose `last_seen_at` is more than 90 days old. The dispatcher pushes only to those. See [Reaching the invitee](02-architecture.md#reaching-the-invitee).

## Indexes and why each exists

| Index | Serves | Note |
|---|---|---|
| `users.email` unique | login, register race | emails stored lower-cased |
| `devices.expo_push_token` unique | device upsert | a token moves to whoever signs in on that phone |
| `devices (user_id) WHERE disabled_at IS NULL` | dispatcher: phones that can show a push, per user | partial: dead tokens don't bloat it; the notifications state and the Android 90-day check filter the few rows it finds |
| `invitations (inviter_id, invitee_id) UNIQUE WHERE status = 'pending'` | "already invited" | the database enforces it; a double-tap can't create two |
| `invitations (invitee_id, created_at)`, `(inviter_id, created_at)` | inbox and sent lists | keyset pagination |
| `invitations (expires_at) WHERE status = 'pending'` | expiry job | |
| `invitations (created_at)` | funnel by date range | |
| `notifications.dedupe_key` unique | idempotent enqueue; funnel join | |
| `notifications (next_attempt_at) WHERE status = 'pending'` | **the dispatcher's claim** | stays tiny however many rows are finished |
| `notifications (locked_until) WHERE status = 'sending'` | reclaiming stalled work | |
| `notifications (created_at) WHERE email_status = 'none' AND status IN ('unreachable', 'failed')` | invitation emailer's scan | partial: only rows push couldn't deliver whose email is undecided; the emailer reads only its last `INVITE_TTL_DAYS` |
| `notifications (email_at) WHERE email_status = 'pending'` | reclaiming email claims a dead worker left | partial: only claims in flight |
| `notifications (user_id, created_at)` | inbox, support trace | |
| `push_tickets (created_at) WHERE receipt_status = 'pending'` | receipt poller | |
| `push_tickets (notification_id)` | support trace; the receipt poller's check for a ticket still alive | |
| `sessions (user_id)` | a user's sessions; cascade on account delete | |
| `sessions.token_hash` unique, `(family_id)` | refresh, family revoke | `replaced_by` has no index: it's only read from the row already found by `token_hash`, then followed by primary key |

Two reads have no index of their own: the support trace's list of a member's phones, disabled ones included, and the cascade from `devices` to `push_tickets`. A member has a handful of phones, so the first stays cheap; account deletion ([production readiness, row 11](09-production-readiness.md#the-gate)) adds `devices (user_id)` and `push_tickets (device_id)` with the cascade it relies on.

## Constraints that encode business rules

- `invitations_not_self`: `CHECK (inviter_id <> invitee_id)`.
- One pending invitation per inviter and invitee (partial unique index above); the reverse direction is a separate invitation.
- Enum types for every status, so a typo can't create a new state.
- A confirmed notification never goes back: the ack and the dispatcher's `sent` update both keep `delivered` and `opened` (`CASE WHEN status ... THEN status`), and the dispatcher records a result only while the row is still on its own claim. An unconfirmed one can return to `pending` to be retried (a failed send, an expired lease, a retryable receipt error).
- At most one invitation email per person per 24 hours: the emailer claims `users.last_invitation_email_at` with an `UPDATE` that re-checks it against the latest row, so two workers can't both claim one person. A crashed worker can rarely cause a second: a claim unsettled after 10 minutes goes back to the queue with the person's day.

## Growth and retention

At 1 million invitations a month, `notifications` grows by roughly 1.5 million rows a month (1.5 per invitation, see the scaling plan) and `push_tickets` by one row per phone pushed to. The [benchmarks](benchmarks/README.md) show the hot queries stay flat to 2 million rows because of the partial indexes. Retention plan: keep 13 months of notifications for the funnel; move older rows to cold storage with a monthly job, or, later, partition by month (`PARTITION BY RANGE (created_at)`) and drop old partitions, which first means reworking the primary key and the unique `dedupe_key`, because Postgres needs the partition key in both. See the [scaling plan](04-scaling-plan.md). `sessions` gets a row per sign-in and per refresh; an hourly job deletes rows past `expires_at`, so it holds at most `REFRESH_TOKEN_TTL_DAYS` (30) of them.
