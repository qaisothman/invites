# Tracking plan

What Invites measures, where each fact lives, and where it may go. One rule underneath: **the database row is the event.** Every funnel step is a timestamp or a status the system writes anyway, so the numbers come from what the system did, and no separate analytics call has to be remembered. Three facts are reported by the phone: that a push arrived, that it was tapped, and the phone's notifications state.

## Events

Names are `object_action`, past tense, snake case. "Recorded as" is the source of truth; any analytics event is a copy of it.

| Event | When | Recorded as | Properties |
|---|---|---|---|
| `invitation_created` | A member invites another | `invitations.created_at` | invitation id, inviter id, invitee id, has message (yes or no, never the text) |
| `invitation_push_sent` | Expo accepted the push for at least one phone | `notifications.sent_at` | platform of each phone (from `push_tickets` and `devices`) |
| `invitation_found_unreachable` | No phone of the invitee's can show it, or every token was dead | `notifications.status = 'unreachable'` | |
| `invitation_push_failed` | The push failed for good | `notifications.status = 'failed'` | last error |
| `invitation_push_withdrawn` | The invitation was cancelled or expired before its push went out; nothing was sent | `notifications.status = 'withdrawn'` | |
| `invitation_delivered` | A phone confirmed the push: its ack, or a tap on it | `notifications.delivered_at` | |
| `invitation_emailed` | The invitation went into the invitee's email | `notifications.email_status = 'sent'`, `email_at` | |
| `invitation_email_opted_out` | Due an email, but the invitee had turned emails off | `notifications.email_status = 'opted_out'` | |
| `invitation_opened` | The invitee tapped the push or opened the invitation in the app | `invitations.opened_at` | |
| `invitation_accepted` / `invitation_declined` | The invitee answered | `invitations.status`, `responded_at` | |
| `invitation_cancelled` / `invitation_expired` | The inviter withdrew it, or 14 days passed | `invitations.status` | |
| `device_reported` | The app reported its push token and notifications state | `devices.notifications`, `last_seen_at`; `device_reports_total` | platform, notifications state, app version |

The [funnel report](../api/src/invitations/funnel.sql.ts) (`GET /admin/funnel/invitations`) is these definitions in one query, for the invitations created between `from` and `to`. Each step carries its conversion from the step it is a subset of: push sent from created, delivered from push sent, opened from created, accepted from opened.

## Metrics

| Metric | Definition | Kind |
|---|---|---|
| **Acceptance rate** | accepted ÷ created, for invitations created in the period, read 14 days later | The input metric: the number the team moves |
| Reach | (push sent or emailed or opened) ÷ created | Plumbing |
| Delivered rate | delivered ÷ push sent (the funnel's delivered step), by platform and app version | Plumbing |
| Unreachable rate | unreachable per 1,000 created | Plumbing |
| Time to delivery | p50 and p95 of delivered minus created, for pushed invitations | Plumbing |
| Email payoff | emailed invitations opened, and accepted, after the email ÷ emailed | Does the second channel earn its place? |
| Email opt-out rate | opted out ÷ (emailed + opted out) | Guardrail |
| Notifications off | share of device reports with `off`, by app version | Guardrail: a release that breaks the prompt |
| Spam complaint rate | from Google Postmaster Tools | Guardrail: below 0.1% |

Two numbers would be agreed before members use it, and written here: a target acceptance rate, and the rate that would mean Invites isn't working ([what production would take](12-what-production-would-take.md#decisions-production-would-need)). Agreeing them afterwards lets any result look like success.

## Where data may go

| Destination | What | What never |
|---|---|---|
| Postgres | Everything above: the product's own record | |
| Prometheus | Counts and timings by outcome; device reports by platform, notifications state and app version | User ids, emails, anything per person |
| Logs | Request id, user id, method, path (without the query string), status, duration | Message text, push tokens, ack tokens, unsubscribe signatures, email addresses in production |
| Product analytics, if one is added | Copies of the events above, keyed by an opaque user id | Message text, email addresses, names |
| Ad platforms (for example Meta's Conversions API) | Nothing from this feature | Any invitation event |

**Why invitations stay out of ad platforms:** an invitation is a fact about two people, and the invitee never agreed to their data reaching an ad network. Conversion events for ads (install, sign-up) belong to a separate tracking plan, sent only with consent where the law requires it, and never with who invited whom.

## Gaps

- **`unreachable` and `failed` are current states.** Viewing the invitation in the app later moves the notification to `opened`, so the unreachable rate counts invitations still unreachable. To count every one, add `notifications.unreachable_at`.
- **The funnel has no platform or app-version split.** `GET /admin/funnel/invitations` returns totals; the split is a join of `push_tickets` and `devices`, and `devices.app_version` is the version each phone last reported, not the one it ran when the push was sent.
- **`delivered` undercounts on iOS.** The phone's confirmation is best effort: iOS may delay or drop the background handler ([ADR 0003](adr/0003-at-least-once-delivery.md#consequences)). Read the delivered rate by platform, and treat it as a floor.
- **Turning invitation emails off isn't timestamped.** `users.invitation_emails` holds the current setting only. If opt-out trends matter beyond the per-invitation `opted_out` count, add `invitation_emails_changed_at`.
- **The funnel reads the same database the app writes to.** That's fine to about 10 million rows; then it moves to a daily rollup and a warehouse ([scaling plan](04-scaling-plan.md)).
