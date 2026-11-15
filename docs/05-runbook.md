# Runbook

Every alert in [`ops/alerts.yml`](../ops/alerts.yml) links to a section here. Each section is: what you see, how to confirm, what to do.

<a id="never-got-it"></a>

## "I never got the invitation"

**Confirm in one call:** `GET /admin/users/:userId/notification-trace` (admin token). It returns the user's devices, each with its `notifications` state (`allowed`, `not_asked` or `off`) and `last_seen_at`, and, for each recent notification, its status, its `emailStatus`, and every send attempt per device with Expo's ticket and receipt. Notification fields come back in camelCase (`emailStatus`, `emailAt`, `emailAttempts`, `emailError`, `lastError`, `nextAttemptAt`, `transportFailures`), and each send attempt carries the claim it came from (`attempt`); device fields come back as columns (`notifications`, `last_seen_at`, `disabled_reason`).

A push goes only to a reachable phone: signed in, last report `allowed`, and not an Android phone silent for 90 days. With none, the notification is `unreachable`, and the invitee is emailed once it's 15 minutes old ([Reaching the invitee](02-architecture.md#reaching-the-invitee)).

| What the trace shows | Meaning | Action |
|---|---|---|
| No notification row | The invitation was never created, or for someone else | Check the invitation and invitee id |
| `pending` with a future `nextAttemptAt` and `lastError` | Provider outage or a provider-side error, retrying with backoff | See [Expo outage](#expo-outage), or the credentials row below |
| `unreachable`, no device, or every device `disabled_reason = signed_out` | Not signed in on any phone | The invitation email covers it; check `emailStatus` |
| `unreachable`, a device with `notifications = off` | Only Settings can turn them on: refused, turned off in Settings, or the Android "Invitations" channel blocked | Ask them to turn on notifications for Invites in Settings (the inbox prompt's "Open Settings" goes there). The phone re-reports when they return to the app |
| `unreachable`, a device with `notifications = not_asked` | Notifications not allowed yet | The inbox prompt's "Turn on" shows the OS prompt |
| `unreachable`, an Android device with `last_seen_at` over 90 days ago | Treated as hibernated: Android resets the permissions of an app left unused for a few months and stops its pushes | Opening the app re-reports the phone; the next invitation is pushed |
| `unreachable`, devices `disabled_reason = DeviceNotRegistered` | App uninstalled: Expo says the token is dead | If they still have the app, opening it re-registers the token |
| `sent`, receipts `ok`, never `delivered` | Apple/Google accepted it; the phone didn't confirm | Focus mode, or notifications turned off since the phone's last report. The phone's ack is best effort: iOS throttles it and never runs it for an app the user force-quit |
| `failed`, `lastError` set | Push gave up: 8 transport attempts (`transportFailures`) over about 5 to 11 minutes for an outage, or 24 hours for a credentials or rate-limit error; or every receipt of its latest send was rejected | The invitation email covers it; check `emailStatus` |
| `withdrawn` | The inviter cancelled the invitation, or it expired, while its push waited. Nothing was sent, and nothing failed | Nothing: no push or email goes out for a closed invitation |
| `pending`, `lastError` mentions `InvalidCredentials` / `MismatchSenderId` (at send or in a receipt) or `ExpoAccessDenied` | Our push credentials are missing or broken; every push is failing | **Incident.** Upload them from `app/` with `set -a; . ./.env; set +a; npx eas-cli@latest credentials` (APNs key for iOS, FCM key for Android; [app/README.md](../app/README.md#real-push-on-an-iphone)), or fix `EXPO_ACCESS_TOKEN`. These errors don't use up any of the 8 transport attempts: each notification is retried with backoff, at most 30 minutes apart, until it is 24 hours old, so the queue drains once they're fixed. Until then the notifications stay `pending` and their invitees get no email |
| `emailStatus = none` on an `unreachable` or `failed` notification | Under 15 minutes old (`EMAIL_AFTER_SECONDS`); the invitation was cancelled or expired; it isn't a new invitation (only `invitation.received` is emailed; `invitation.accepted` never is); older than the invitation's lifetime (`INVITE_TTL_DAYS`); the invitee was emailed in the last 24 hours (another notification with `emailStatus = sent` and `emailAt` in that window), so it goes in their next email; or a provider error is being retried (`emailAttempts` 1 to 4 and `emailError` set; the next try comes 5, 10, 20 or 40 minutes after `emailAt`) | Nothing: an open invitation goes in their next email; other types are never emailed |
| `emailStatus = pending` | Claimed and being sent. Older than 10 minutes (`emailAt`), the worker died mid-send, and the next run puts it back in the queue (a rare duplicate email is possible) | Nothing. Still `pending` well past 10 minutes means no emailer run is starting: see [invitation emails stalled](#email-stalled) |
| `emailStatus = sent` | Emailed at `emailAt`, together with everything else waiting for them | Ask them to check spam and the address on their account. While `EMAIL_DRIVER=log`, the email was only written to the log ([Sending real email](08-sending-real-email.md)) |
| `emailStatus = opted_out` | They turned invitation emails off, in Profile or from an email's link | They can turn "Invitation emails" back on in Profile for future invitations; this one stays in their inbox in the app |
| `emailStatus = failed`, `emailError` set | The email provider refused it 5 times | See [invitation emails failing](#email-failures) |

<a id="outbox-backlog"></a>

## Outbox backlog growing

**Alert:** `outbox_oldest_due_seconds > 120` for 5 minutes.

1. Is the worker running? Check the worker deployment and its logs for `dispatch failed`.
2. Is it sending? `rate(notifications_dispatched_total[5m])` by outcome. Mostly `retry` means Expo; go to [Expo outage](#expo-outage).
3. Is it just volume? If outcomes are `sent` but the backlog still grows, scale the worker (more replicas; each claims with `SKIP LOCKED`, so they don't collide). Stop before ~600/s total: that's Expo's per-project limit.
4. Is the database slow? Check claim query time. If `notifications_due_idx` is missing or bloated, `REINDEX INDEX CONCURRENTLY notifications_due_idx`.

<a id="expo-outage"></a>

## Expo outage

Retries back off automatically (5 s doubling, with jitter). A send that fails on the network, times out, or gets a 429 or 5xx from Expo gets 8 transport attempts, over about 5 to 11 minutes, however many provider-side retries came before; then it is `failed`, and an invitation's invitee is emailed once the notification is 15 minutes old. You don't need to do anything for an outage shorter than that.
- A slow Expo can't keep a batch sending past its lease: no request starts that couldn't finish 40 s after the claim, 20 s before the lease ends. The pushes left unsent go back in the queue a few seconds later without using up an attempt, so another worker never sends a push this one is still sending.
- Check https://status.expo.dev.
- For a longer one, invitation notifications that give up become `failed`, and their invitees are emailed, at most one email a day each. Expect `invitation_emails_total{outcome="sent"}` to rise with them.
- After recovery, the backlog drains on its own; jitter spreads the retries out.

<a id="receipt-errors"></a>

## Receipt errors spike

- `DeviceNotRegistered` rising after a release: did the new build change the bundle id or the push entitlement?
- `InvalidCredentials` / `MismatchSenderId`: push credentials missing, expired or mismatched. Fix them now; every push is failing. When Expo reports them at send, the API logs `Push credentials are missing or invalid` on each send, and `PushProviderFailing` fires because every attempt is a retry. When they show only in receipts, the send counted as `sent`, so `DeadTokenSpike`, this section's alert, is the signal. Either way the notifications are retried until they are 24 hours old ([the trace's credentials row](#never-got-it)).

<a id="api-errors"></a>

## API errors

`5xx` rate above 1%. Every error response has a `requestId`; find it in the logs (one line per request, carrying a JSON object) to see the route, the user and the stack trace from `HttpExceptionFilter`. Most likely causes: database unreachable (check `/health/ready` and the DB), pool exhausted (look for `timeout exceeded when trying to connect`), or a bad deploy (roll back the image; migrations are backward compatible, see [releases](07-release-and-migrations.md)).

<a id="api-latency"></a>

## API latency

p95 above 300 ms. Check `http_request_duration_seconds` by route. A single slow route usually means a missing index or a regressed query (`EXPLAIN ANALYZE` it). Everything slow means CPU (scale the API) or the database.

<a id="scrape-failing"></a>

## API or worker not answering

**Alert:** `up{job=~"api|worker"} == 0` for 2 minutes: Prometheus can't scrape the API or the worker. A database outage doesn't cause it, because the database gauges read NaN and the scrape still succeeds; the process itself is down, restarting or not answering.

1. Which one? The alert's `job` label is `api` or `worker`.
2. Is it running? Check the deployment, its restarts and its last log lines. A bad environment stops it at boot with `Invalid environment: ...`.
3. Does it answer? `GET /health/live` on the instance; `/health/ready` also checks the database ([API errors](#api-errors)).
4. A bad deploy: roll back the image; migrations are backward compatible ([releases](07-release-and-migrations.md)).

<a id="email-surge"></a>

## Invitation email surge

**Alert:** the share of notifications no phone could show in the last hour (`unreachable` among `sent`, `unreachable` and `failed` in `notifications_dispatched_total`) is more than 1.5 times the same hour last week, and more than 100 invitations were emailed in that hour. About half of phones never allow notifications, so watch the share against last week, not the count.
- A release broke the prompt? Compare the share of `device_reports_total{notifications="off"}` by `app_version`. One version far above the others broke the permission prompt or the Android "Invitations" channel; ship the fix as an OTA update or a store release ([mobile release](07-release-and-migrations.md#mobile-release)).
- Tokens going dead? An invitee whose every token is dead at send (`DeviceNotRegistered`) counts as `unreachable` too. `DeviceNotRegistered` rising after a release: see [receipt errors](#receipt-errors).
- If an abuse pattern appears (one inviter, many invitees), the per-user invite quota (`INVITES_PER_HOUR`) is the lever.

<a id="email-stalled"></a>

## Invitation emails stalled

**Alert:** `invitation_emails_oldest_due_seconds > 600` for 10 minutes. The oldest invitation that should have been emailed has waited more than 10 minutes past `EMAIL_AFTER_SECONDS`. Invitees held by the one-email-a-day limit don't count: they wait by design.

1. Is the worker running? Only an instance with `WORKERS_ENABLED=true` sends emails. Check the worker deployment, or [ScrapeFailing](#scrape-failing).
2. Are its runs failing? Look in the worker logs for `invitation-emails failed`, followed by the stack trace.
3. Is the provider answering? Sends go one person at a time, and a run starts only once the one before has ended, so a provider that hangs holds up every email. Check its status page. A claim left `pending` for more than 10 minutes goes back in the queue at the start of the next run, on any worker.
4. Is the provider refusing? Emails waiting out a retry delay count here too, so a provider outage shows up here as well as in [invitation emails failing](#email-failures).

<a id="email-failures"></a>

## Invitation emails failing

An invitation email was given up in the last 15 minutes: the provider refused it on all 5 attempts. Each invitation is retried on its own: a refused send stores the provider's error in `email_error`, and the next attempt waits 5, 10, 20, then 40 minutes after the last one, about 75 minutes in all; after the fifth refusal the emailer sets `email_status = failed`. Every run with a refusal logs `invitation email problems` with the first error. A refused send releases the person's one email for the day, so neither a retry nor their next invitation waits 24 hours. `EMAIL_DRIVER=log` never refuses, so this fires only with a real provider.
- Read the errors: `SELECT email_error, count(*) FROM notifications WHERE email_status = 'failed' AND email_at > now() - interval '1 hour' GROUP BY 1`.
- Provider down: check its status page. `invitation_emails_total{outcome="retry"}` rising with no `sent` confirms it.
- Credentials, sending domain or account status: see [Sending real email](08-sending-real-email.md).
- The invitations stay in each invitee's inbox in the app. To email them again once the provider works, set `email_status = 'none'` and `email_attempts = 0` on the failed rows. The next run picks up each one whose invitation is still open; anyone emailed in the last 24 hours gets theirs in their next email.
