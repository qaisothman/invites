# ADR 0001: One NestJS service, split into modules, deployed as two roles

**Status:** accepted · **Date:** 2026-11-13

## Context
The product is small (one team, a handful of entities) but has two very different workloads: HTTP requests that must be fast, and background delivery work that must be reliable and can be slow (Expo round trips, retries, receipts 15 minutes later).

## Decision
One NestJS codebase and one Docker image, organised as feature modules (`auth`, `users`, `devices`, `invitations`, `notifications`, `workers`, `metrics`). The image runs two long-lived roles chosen by `WORKERS_ENABLED`, plus a one-off migrate job before each release:
- **API**: serves HTTP, scales with traffic.
- **Worker**: runs the dispatch, receipt, invitation-email and expiry loops, scales with backlog.

Modules write only their own tables, through their own services. Reads cross in a few places, on purpose:
- `auth` creates the `users` row at sign-up and reads it at sign-in and refresh;
- `invitations` reads `users` for the inviter and invitee;
- the `/metrics` gauges read `notifications`, `invitations` and `users` at scrape time;
- the funnel report reads across invitations and notifications;
- the support trace lists the user's devices with their notifications state;
- the invitation emailer reads the invitation and claims the invitee's `users` row (`last_invitation_email_at`) in the same transaction as the notifications it emails, which is what holds it to one email a day. Its unsubscribe link sets `users.invitation_emails` ([ADR 0006](0006-email-for-invitees-push-cannot-reach.md)).

## Alternatives
- **Microservices** (invitations service + notification service + queue). Independent deploys and scaling, at the cost of a network hop inside every invite, distributed transactions (the outbox gets harder), and more to operate. Not worth it at this size.
- **One process doing both.** Simplest, but a slow Expo or a big backlog would steal CPU from HTTP requests, and you can't scale one without the other.

## Consequences
- A transaction can cover the invitation and its notification (see ADR 0002).
- The notifications module can be lifted into its own service later without rewriting it: it already has a clear interface (`enqueue`, acks, trace) and owns its tables. The invitation emailer is the one part that would need the invitation's state and the invitee's email settings passed to it, instead of reading them from `invitations` and `users`.

## When to revisit
- A second team owns notifications, or it needs its own release cadence.
- Notifications serve more than this product.
- Stage 3 of the [scaling plan](../04-scaling-plan.md): the outbox moves to a log, and the notifications module becomes its own service.
