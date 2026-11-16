# ADR 0004: Push and email providers behind interfaces, chosen by config

**Status:** accepted · **Date:** 2026-11-13

## Decision
The dispatcher depends on a `PushSender` interface and the invitation emailer on an `EmailSender` interface, bound by injection tokens (`PUSH_SENDER`, `EMAIL_SENDER`) in `NotificationsModule` from config (`PUSH_DRIVER`, `EMAIL_DRIVER`).

- Production: `ExpoPushSender` (plain `fetch`, chunks of 100, 4 requests in flight, 10-second timeout; 429, 5xx and network errors are retryable, and so is a refused access token (401 or 403), like the APNs and FCM credential errors; a rejected request of several messages is sent again one message at a time, so one bad message can't fail the others, and a message rejected on its own is final).
- Email, until a provider is connected: `LogEmailSender` (`EMAIL_DRIVER=log`, the default) writes each email to the log. Outside production that's the whole email, with the unsubscribe token cut; in production, only the masked address and the subject, and the API logs a warning at boot that invitation emails are logged, not sent. [Sending real email](../08-sending-real-email.md) lists what a real provider needs.
- Tests and load tests: `FakePushSender`, whose behaviour is set per token (`ok`, `dead`, `flaky`, `no_credentials`, `receipt_error`, `receipt_rate_limited`) and which can add Expo-like latency.
- Tests: `FakeEmailSender`, which keeps every email it sends and fails for the addresses a test chooses.
- `PUSH_DRIVER=fake` and `EMAIL_DRIVER=fake` are refused at boot when `NODE_ENV=production`.

## Why
- Tests exercise every failure mode (dead tokens, outages, receipt errors, refused emails, races) against a real database without touching the network.
- Adding an email provider, or another push service that takes Expo tokens, is one class, its name in the driver's allowed values (`PUSH_DRIVER` or `EMAIL_DRIVER`) and its branch in the factory.
- The dispatcher and the emailer call only the interfaces, so the provider's HTTP calls, limits and retries stay in `notifications/providers`. Expo's data model does not: `POST /devices` takes and stores an Expo push token, `push_tickets` keeps Expo's ticket id, and the receipt poller follows Expo's ticket-then-receipt model through `PushSender.getReceipts`.

## When to revisit
- The product sends more kinds of notifications than invitations, people other than engineers need to edit the wording, or members need a preference centre or digests. Then compare a notification platform (Knock, Novu, Courier) against extending this one.
- Push moves to APNs and FCM directly: a new `PushSender` plus a token migration. The app registers native device tokens, `POST /devices` accepts them, and the receipt poller isn't needed where the provider answers in the send response.
