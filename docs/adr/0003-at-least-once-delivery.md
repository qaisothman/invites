# ADR 0003: At-least-once delivery, with a delivered/opened signal from the app

**Status:** accepted · **Date:** 2026-11-13

## Context
Expo has no idempotency key. If a worker sends a batch and dies before recording the result, the system can't know whether Expo received it. It must either risk a lost notification or risk a duplicate.

Separately, "Expo accepted it" is not "the phone showed it". Expo's ticket says the message was queued; the receipt (about 15 minutes later) says Apple or Google accepted it; neither says it appeared on the screen. Both report success for a phone with notifications off.

## Decision
1. **Prefer a duplicate to a loss.** A stalled `sending` row goes back to `pending` and is sent again. A rare duplicate push is mildly annoying; a lost invitation is lost growth.
2. **The app confirms.** When a push arrives, the app calls `POST /notifications/:id/ack { token }`: from its foreground listener, from a background task, and, for a push iOS showed without waking the app, the next time the app opens. When it's tapped, `POST /notifications/:id/opened`. Viewing the invitation in the app counts as opened too. Statuses only move forward (`opened` never goes back to `delivered`).
   - Pushes are sent with `contentAvailable: true` so iOS wakes the app's background task, and with an explicit Android `channelId` the app creates at startup (a push naming a missing channel is never shown).
   - Each push carries `ackToken`, an HMAC of the notification id under a key derived for this purpose, so the confirmation needs no session. A fresh background runtime refreshing the session would race the app's own refresh, and with rotating refresh tokens that race can end the sign-in. `POST /notifications/:id/delivered` does the same with a session. The token can mark only its own notification delivered, so leaking one is harmless.
   - The background task acks only while notifications are allowed. iOS can wake it for a push it won't show, and acking that would count a push nobody saw as delivered.
3. **Receipts close the loop on dead tokens.** A `DeviceNotRegistered` ticket or receipt disables the device, so the next notification doesn't waste a send on it. A notification whose every ticket says `DeviceNotRegistered` is `unreachable`.
4. **Push goes only where it can be shown, and the ack triggers nothing.** The dispatcher pushes only to phones that can show it: signed in, last report `allowed`, and not an Android phone silent for 90 days. With none, the notification is `unreachable`. An `unreachable` or `failed` invitation becomes eligible for the email; a missing ack never does ([ADR 0006](0006-email-for-invitees-push-cannot-reach.md)). Acks are best effort, so a rule built on them would email people who saw the push.

## Consequences
- The funnel's "delivered" step is real: it comes from phones, not from a provider's queue.
- iOS may delay or drop background handlers, so some delivered pushes are never confirmed. That undercounts the funnel's "delivered" step and changes nothing else: no email depends on the ack.
- A `MessageRateExceeded` receipt (Apple or Google throttled us) puts the notification back in the outbox with backoff, as Expo recommends, and leaves the device enabled.
- `InvalidCredentials` and `MismatchSenderId`, at send or in a receipt, and Expo refusing our access token (HTTP 401 or 403), are retried the same way. They mean our credentials are missing or wrong, which fails every message until someone fixes it; failing the notifications would give up on the push for good.
- These provider-side errors don't use up the 8 attempts a transport failure gets (network, timeout, Expo 429 or 5xx, about 5 to 11 minutes in all): they are retried at most 30 minutes apart until the notification is 24 hours old (`PUSH_GIVE_UP_AFTER_HOURS`), then failed, and the invitation is emailed if it is still open. Until then it stays `pending`, so no email goes out for it. Transport failures have a counter of their own (`transport_failures`), apart from the claim number that fences each result (`attempts`), so an outage after hours of provider-side retries still gets all 8.
- Only the latest send's receipts decide: a rate limit on an earlier send doesn't put back a notification whose resend was rejected for good.
- Any other rejection is final: the notification is marked failed, which makes an invitation eligible for the email.
- A batch has until 40 seconds after its claim to send, inside its 60-second lease: no request to Expo starts that couldn't finish by then, and what was left unsent goes back in the queue without using up an attempt. A slow Expo can't keep a worker sending past its lease, when another worker would claim the same rows and push them again.
- A push whose invitation was cancelled or expired while it waited is `withdrawn`: nothing is sent, it isn't a failure, and no email follows.

## When to revisit
- Support sees duplicate pushes or emails more than about once in 10,000 invitations: set Expo's `collapseId` (iOS) and `tag` (Android) to the notification id, so a duplicate replaces the first copy instead of showing twice. Carry the same id over if push moves to APNs and FCM directly (stage 3 of the [scaling plan](../04-scaling-plan.md)).
- iOS delivered over sent falls while sent holds steady: either confirmations are being lost, or phones are keeping a stale `allowed` report ([risk 4](../10-risks.md)). Tell the two apart before trusting the step; the funnel has no platform split yet ([tracking plan, gaps](../11-tracking-plan.md#gaps)).
