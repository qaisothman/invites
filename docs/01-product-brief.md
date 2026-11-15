# Product brief: invitations that arrive

## The problem

A member invites another member. Whether the invitee ever hears about it decides whether the product grows, yet today nobody can answer three questions:

1. Did the invitation notification reach the invitee's phone?
2. If not, where did it stop: notifications turned off, no phone at all, a dead token, Expo, Apple or Google, or the app itself?
3. Of the invitations sent this week, how many were delivered, opened and accepted?

Without those answers, a drop in the invite funnel looks the same whether it's a product problem (people don't want to accept) or a plumbing problem (people never saw it). Teams then fix the wrong thing.

## Goal

Every invitation reaches the invitee, and every step from "created" to "accepted" is measured.

## Users and jobs

| Who | Job |
|---|---|
| Inviter | Invite someone and know they'll hear about it. |
| Invitee | Hear about it quickly, once, and answer in one tap. |
| Founder | See the invite funnel and where it leaks, without asking an engineer. |
| Support | Answer "I never got it" in one minute, with evidence. |
| Engineer on call | Be told when delivery degrades, before users notice. |

## Requirements

**Functional**
- Members invite other members, with an optional message (up to 280 characters). Invitations expire after 14 days.
- Accepting or declining is one tap, works offline-retried (idempotent), and only the first answer counts.
- Each phone tells the server whether it can show notifications: allowed, not asked yet, or off.
- The invitee gets a push on every phone of theirs that can show it: signed in, notifications allowed, and not an Android phone unused for 90 days (Android hibernates the app and its pushes stop). When the push arrives, and when it's tapped, the app tells the server.
- While a phone can't show notifications, the inbox offers to turn them on (or to open Settings, when only Settings can). "Not now", or refusing the OS prompt, quiets it for 7 days. It is never a pop-up on launch and never a gate.
- When no phone of the invitee's can show the push, or the push fails for good, the invitee gets an email with a link once the invitation is 15 minutes old, unless they've opened it by then. At most one email a day, with everything waiting in it; a worker crash mid-send can rarely cause a second. A switch in Profile and a link in every email turn these emails off.
- Pushes and emails name the inviter, never the message; the email adds a link and when the invitation expires. A display name can't contain a link (`http:`, `https:`, `www.` or a domain followed by a path, such as `evil.example/unlock`, full-width look-alikes included), a control character, a line break, or a character that hides or reorders text (bidi controls, the zero-width space, the byte order mark); a bare domain (`evil.example`) and dotted names (`J.Smith`) pass, and emoji and Persian names keep their joiners. The message is shown only in the app.
- An admin funnel report: created, push sent, delivered, opened, accepted, each with its conversion from the step it is a subset of, and time to delivery for pushed invitations. Drop-off is counted where each invitation stopped: no phone could show it, push failed, withdrawn before its push went out, still queued, declined. Invitation emails: sent, opted out, and emailed invitations opened or accepted after the email. Delivered counts pushes a phone confirmed; seeing an invitation in the app counts as opened.
- A per-user delivery trace for support: each phone with its notifications state, and each notification's push and email status.

**Non-functional (targets, see [SLOs](06-slos-and-alerts.md))**
- API availability 99.9% per month; p95 latency under 300 ms.
- 95% of invitation pushes handed to Expo within 60 seconds of the invitation; 99% of invitations, 20 minutes after they're created, pushed to a phone that can show it, seen in the app, or emailed (unless the invitee turned invitation emails off). Invitations held by the one-email-a-day limit are counted separately.
- No invitation without its notification, and no notification for an invitation that didn't commit.
- One invitation email per person a day. Losing a notification is worse than sending one twice (at-least-once delivery), so a worker crash mid-send can rarely mean a second push or email.

## Out of scope for this version

- Inviting people who aren't members yet (needs deferred deep links and an install attribution provider).
- In-app chat after acceptance.
- SMS. Email covers the invitees push can't reach ([ADR 0006](adr/0006-email-for-invitees-push-cannot-reach.md)).
- Reminder emails, and email for anything but a new invitation.
- Notification preferences beyond the invitation-email switch, and quiet hours.

## Success metrics

| Metric | Why |
|---|---|
| Accepted / created, read 14 days after | Is the product working? The number the team moves ([tracking plan](11-tracking-plan.md#metrics)) |
| Delivered / push sent (by platform, by app version) | Is the plumbing working? |
| p95 seconds from invitation to delivery | Does it feel instant? |
| Unreachable per 1,000 invitations | How many invitees push can't reach |
| Emailed invitations opened or accepted afterwards | Does the second channel pay off? |
| Share of device reports with notifications off (by app version) | Is the permission prompt working? |
