# ADR 0002: A transactional outbox in Postgres, not a message queue

**Status:** accepted · **Date:** 2026-11-13

## Context
When an invitation is created, the invitee must eventually be told: by push, or by email when no phone of theirs can show one. Two classic bugs:
1. **Dual write:** save the invitation, then publish to a queue. If the process dies in between, the invitation exists and nobody is ever notified.
2. **Send inside the transaction:** call Expo, then commit. If the commit fails, the person was notified about an invitation that doesn't exist; and a slow Expo holds a database transaction open.

## Decision
Write the notification as a row (`status = 'pending'`) in the same transaction as the invitation. A dispatcher claims due rows and sends them:

```sql
WITH due AS (
  SELECT id FROM notifications
  WHERE status = 'pending' AND next_attempt_at <= now()
  ORDER BY next_attempt_at LIMIT $batch
  FOR UPDATE SKIP LOCKED)
UPDATE notifications SET status = 'sending', attempts = attempts + 1,
       locked_until = now() + interval '60 seconds'
FROM due WHERE notifications.id = due.id
RETURNING ...
```

- `FOR UPDATE SKIP LOCKED` lets any number of workers claim in parallel without waiting on each other or taking the same row.
- `locked_until` is a lease. A worker that crashes mid-batch leaves rows in `sending`; once the lease expires, `reclaimStale()` returns them to `pending`.
- A partial index on `next_attempt_at WHERE status = 'pending'` keeps the claim fast however large the table grows: it only covers rows waiting to be sent. See the [benchmarks](../benchmarks/README.md).
- `dedupe_key` is unique, so enqueueing the same business event twice is a no-op.
- The invitation email runs off the same rows. The dispatcher marks a notification `unreachable` when no phone of the user's can show it. The invitation emailer finds `unreachable` and `failed` notifications through a second partial index, on `created_at WHERE email_status = 'none' AND status IN ('unreachable', 'failed')`, and records the outcome in `email_status`. Several workers can run it at once: each first claims the invitee's `users.last_invitation_email_at`, which is also what holds it to one email a day ([ADR 0006](0006-email-for-invitees-push-cannot-reach.md)).

## Alternatives
- **Redis + BullMQ.** Higher throughput and built-in retries, but the dual-write problem comes back (or needs an outbox anyway), and it's one more stateful system to run, back up and monitor.
- **SQS / Pub/Sub.** Same dual-write issue, plus vendor coupling.
- **Debezium/CDC from the outbox table.** The right answer at very large scale; heavy for one team.

## When to revisit
Postgres comfortably handles the claim rate this product needs: one loop sends about 1,000 a second and 16 loops about 14,500 ([benchmarks](../benchmarks/README.md)). The limit that binds first is Expo's documented 600 notifications a second per project, and that is a provider change ([ADR 0004](0004-providers-behind-interfaces.md)), not a reason to leave the outbox. Revisit when other services need to consume the same events, or when the outbox falls behind with workers added: lag over 2 minutes in bursts or the primary over 60% CPU at peak (stage 3 of the [scaling plan](../04-scaling-plan.md)).
