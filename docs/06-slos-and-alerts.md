# SLOs and alerts

An SLO is a promise with a number on it. Each one below has an error budget. The alerts are thresholds on the closest metric that exists today, held for a few minutes so they don't fire on every blip; none computes budget burn yet. The two delivery SLOs (push dispatch, invitee told) are measured from the `notifications` table, not from a metric, and would be a daily query once there is traffic.

| SLO | Target | Measured by | Error budget (30 days) |
|---|---|---|---|
| API availability | 99.9% of requests are not 5xx | `http_request_duration_seconds_count{status=~"5.."}` | about 43 minutes of full outage |
| API latency | 95% of requests under 300 ms | `http_request_duration_seconds` histogram | 5% of requests |
| Push dispatch | 95% of notifications handed to Expo within 60 s of creation | `outbox_oldest_due_seconds`, plus `sent_at - created_at` | 5% |
| Invitee told | 99% of invitation notifications, 20 minutes after creation, pushed to a reachable phone, seen in the app, or emailed (or the invitee turned invitation emails off). Invitations held by the one-email-a-day limit are left out and counted separately, and so are those cancelled or expired before their push went out (`withdrawn`) | `notifications` 20 minutes after `created_at`: `sent_at` or `opened_at` set, or `email_status` `sent` or `opted_out`. Held: the invitee has another notification with `email_status = 'sent'` and `email_at` in the 24 hours before this one was due (`created_at` plus `EMAIL_AFTER_SECONDS`) | 1% |

A reachable phone is signed in, last reported notifications `allowed`, and isn't an Android phone silent for 90 days. Seeing the invitation in the app counts too: it sets `opened_at`. The email goes to invitees push can't reach (no reachable phone, or the push failed for good) once the notification is 15 minutes old ([Reaching the invitee](02-architecture.md#reaching-the-invitee), [ADR 0006](adr/0006-email-for-invitees-push-cannot-reach.md)). An invitation held by the one-email-a-day limit (the invitee was emailed in the 24 hours before) goes in their next email by design, so it's counted on its own, not against the SLO.

With `EMAIL_DRIVER=log`, `email_status = 'sent'` means written to the log. In production without a provider, this SLO and the funnel's email counts overstate how many invitees were told; the API logs a warning at boot when that's the case ([Sending real email](08-sending-real-email.md)).

## Alerts

| Alert | Fires when | Severity | Runbook |
|---|---|---|---|
| OutboxBacklogGrowing | oldest due notification older than 2 minutes, for 5 minutes | page | [outbox backlog](05-runbook.md#outbox-backlog) |
| PushProviderFailing | over 5% of dispatch attempts retried or failed, for 10 minutes | page | [Expo outage](05-runbook.md#expo-outage) |
| ApiErrorRate | over 1% 5xx, for 5 minutes | page | [API errors](05-runbook.md#api-errors) |
| ApiLatencyHigh | p95 above 300 ms, for 10 minutes | ticket | [API latency](05-runbook.md#api-latency) |
| ScrapeFailing | Prometheus can't scrape the API or the worker, for 2 minutes | page | [API or worker not answering](05-runbook.md#scrape-failing) |
| DeadTokenSpike | over 15% of receipts are errors, for 30 minutes | ticket | [receipt errors](05-runbook.md#receipt-errors) |
| InvitationEmailSurge | share of notifications no phone could show, over the last hour, more than 1.5 times the same hour last week, with more than 100 invitations emailed in that hour | ticket | [invitation email surge](05-runbook.md#email-surge) |
| InvitationEmailsStalled | oldest invitation due an email waiting more than 10 minutes past `EMAIL_AFTER_SECONDS`, for 10 minutes | ticket | [invitation emails stalled](05-runbook.md#email-stalled) |
| InvitationEmailFailures | any invitation email given up after 5 attempts, in 15 minutes | ticket | [invitation emails failing](05-runbook.md#email-failures) |

"Page" wakes someone up; "ticket" is for working hours. Nothing pages unless a person has to act now.

## Dashboards to build (Grafana, from the same metrics)

1. **Delivery:** dispatch outcomes per minute (`unreachable` among them), outbox due and oldest age, receipt outcomes, invitation emails by outcome, the oldest invitation waiting for its email (`invitation_emails_oldest_due_seconds`), device reports by notifications state and app version.
2. **API:** requests per second, p50/p95/p99 by route, error rate by route.
3. **Funnel (business):** the `/admin/funnel/invitations` report for a date range: created, sent, delivered, opened, accepted; the drop-off, where invitations stopped (unreachable, push failed, withdrawn, still queued, declined); emails sent and opted out, and emailed invitations opened and accepted after the email.
