# Risks

## Pre-mortem

Imagine Invites went to production and failed three months in. The likeliest stories, most likely first:

1. **Invitations were sent and nobody heard about them.** Notifications were off for about half of members, and the emails landed in spam.
2. **It was used to bother people.** A member sent unwanted invitations with unpleasant messages, and the invitee had no way to report or block them. That led to App Store trouble, or a press story.
3. **The numbers lied.** The funnel said "delivered" or "emailed" when the invitee never saw it, so the team fixed the product when the plumbing was broken (or the other way round).
4. **An outage nobody noticed.** Push credentials expired, or Expo went down, and invitations queued for hours with no one paged.
5. **A privacy complaint.** Someone was emailed at an address they never gave, or asked what the company holds about them, and there was no record of processing to answer from.

Each story maps to rows below.

## Register

Likelihood and impact are high, medium or low. Every risk names who would own it and the signal that would show it happening.

| # | Risk | Likelihood | Impact | Mitigation in place | Still to do | Signal | Would own it |
|---|---|---|---|---|---|---|---|
| 1 | Invitation emails land in spam | Medium | High | One email a day at most, a service message only, one-click unsubscribe headers | Domain authentication, warm-up, seed-inbox tests ([Sending real email](08-sending-real-email.md)) | `email.openedAfter` low against `email.sent`; complaint rate above 0.1% in Postmaster Tools | Tech lead |
| 2 | Someone signs up with another person's address, and that person gets invitation emails | Medium | Medium | Emails carry no message text; a stop link that needs no sign-in | Verify the address before the first invitation email | Unsubscribes from the email link soon after an account's first invitation email; complaints; support contacts from people with no account | Tech lead |
| 3 | Harassment through invitations | Medium | High | 30 invitations a member an hour, one open invitation per pair, display names can't carry links (`http:`, `https:`, `www.` or a domain followed by a path, look-alikes included) | Report and block, or leave the free-text message out at first ([production readiness, row 12](09-production-readiness.md#the-gate)) | Declines from one inviter well above the median; support tickets | Founder (policy), tech lead (tools) |
| 4 | A phone turns notifications off in Settings and never opens the app again; its last report still says `allowed` | Medium | Low | Known limit, written down ([ADR 0006](adr/0006-email-for-invitees-push-cannot-reach.md#consequences)); Android phones silent for 90 days already count as unreachable | Age out iOS reports too, if the gap proves large | On iOS, delivered over sent falling while sent holds steady | Tech lead |
| 5 | Push credentials expire or are wrong | Low | High | Retried with backoff until the notification is 24 hours old, then emailed; `PushProviderFailing` fires when Expo reports the error at send, `DeadTokenSpike` when only receipts do | Production credentials ([production readiness, row 14](09-production-readiness.md#the-gate)); the alert routed to a pager ([row 7](09-production-readiness.md#the-gate)) | `InvalidCredentials` in tickets or receipts | Tech lead |
| 6 | Expo is down or rate-limits a burst | Low | Medium | Backoff and retries (8 transport attempts, about 5 to 11 minutes), then the invitation email; the outbox holds the work; runbook ready | A send limiter at stage 2; direct APNs and FCM at stage 3 ([scaling plan](04-scaling-plan.md)) | `PushProviderFailing`; `OutboxBacklogGrowing` too if sends time out or retries outrun the worker | Tech lead |
| 7 | An invitee gets a push or an email twice | Low | Low | Accepted by design: a duplicate beats a lost invitation ([ADR 0003](adr/0003-at-least-once-delivery.md)) | None | Support tickets about duplicates | Tech lead |
| 8 | Data lost in a database failure | Low | High | Writes are transactional | Point-in-time recovery and a timed restore ([production readiness, row 9](09-production-readiness.md#the-gate)) | Restore drill time | Tech lead |
| 9 | App Store rejection | Medium | Medium | Notifications are never a gate; the prompt is in context | Account deletion, report and block ([rows 11 and 12](09-production-readiness.md#the-gate)) | Review notes | Tech lead |
| 10 | A data-protection complaint the company can't answer | Low | High | Data kept to what invitations need; no phone numbers; no tracking pixel | Record of processing, privacy notice, retention schedule ([row 13](09-production-readiness.md#the-gate)) | A subject access request or a regulator's letter | Founder |
| 11 | Rotating `JWT_SECRET` breaks unconfirmed acks and old unsubscribe links | Low | Low | Written down; the Profile switch still works ([ADR 0005](adr/0005-auth-tokens.md#trade-offs)) | An independent secret per purpose, with key ids, if rotation becomes routine | Rotation on the calendar | Tech lead |
| 12 | One person holds all the knowledge | High | High | ADRs, runbook, a tested stack anyone can run locally | A second person on call; walk them through the runbook | The first incident with only one person who knows the system | Founder |

## How this page would be kept

- Once Invites serves members: reviewed every two weeks, and after any incident. A risk that happens becomes a runbook entry and, if a decision changes, an ADR.
- A risk is closed when its "still to do" is done and its signal has stayed quiet for a month. Closed rows stay, struck through, so the history is visible.
