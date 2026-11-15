# What production would take

Invites runs locally by design ([run and test it](00-run-and-test-locally.md)). This page is the step after: what serving real members would need, what it would cost, and the decisions that belong to the founder rather than to engineering.

## Where it stands

- **Built and tested:** invitations, push to every phone that can show it, one email for invitees push can't reach, and the funnel from "created" to "accepted". 69 end-to-end tests run against a real database on every push and pull request.
- **Decided and written down:** six [decision records](adr/), each with the trade-offs and when to revisit it, among them [email, not SMS](adr/0006-email-for-invitees-push-cannot-reach.md) (SMS costs 120 to 560 times more per message and invites fraud).
- **Not set up, on purpose:** hosting, an email provider, and the Apple and Google keys that let store builds receive push. The [production readiness review](09-production-readiness.md) lists everything between here and a first real member: 6 of 16 items are done, and the rest is about 13 to 14 working days for one engineer, hosting set-up included.

## Decisions production would need

| Decision | Options | Cost | Time | Recommendation |
|---|---|---|---|---|
| The free-text message in invitations | **Keep it**, with reporting and blocking (Apple and Google ask for these when members write to each other) · **Leave it out** at first | Engineering time only | Keep: +2 to 3 days · Leave out: less, not none (display names are member-written too) | Keep it if a personal note is what makes members accept; otherwise leave it out and test it as the first experiment |
| Email provider | Amazon SES · Postmark · Resend | SES: about $1.50 a month at 10,000 members; the others about $15 to $20 | 1 day to connect; 2 to 3 weeks of warm-up (sending a little more each day, so Gmail and Outlook come to trust a new sender), alongside everything else | SES if hosting is on AWS; otherwise Postmark |
| Hosting | Wherever the company already runs a backend, if it does · a managed platform (for example Render) · AWS | $50 to $150 a month for 2 API instances, 1 background worker and a Postgres database that can be restored to any minute of the last few days | 1 to 2 days | Next to an existing backend if there is one: one place to operate. Otherwise a managed platform |
| Legal sign-off | The lines in the terms and the privacy notice, and the legitimate-interests assessment, listed in [Sending real email](08-sending-real-email.md#5-terms-privacy-notice-and-law) | A few hours of a lawyer's time | Before the first real email | Whoever already owns the privacy notice |
| What success looks like | A target acceptance rate, and the rate that would mean Invites isn't working | | Before members use it | Agree both numbers first ([tracking plan](11-tracking-plan.md#metrics)) |

## Running cost (up to about 10,000 members)

| Item | A month | Note |
|---|---|---|
| Hosting and database | $50 to $150 | Depends on the hosting decision |
| Expo: builds, and app updates that skip store review | $0 to $199 | The free tier may be enough at first; Production is $199 |
| Error tracking (Sentry) | $0 to $29 | Free tier, or Team |
| Email | $1.50 to $20 | Depends on the provider |
| Push notifications | $0 | Expo's push service is free |
| App stores | about $8 | Apple $99 a year; Google $25 once |
| **Total** | **about $60 to $400** | |

Prices checked on 15 November 2026: [Expo](https://expo.dev/pricing), [Sentry](https://sentry.io/pricing/), [Render](https://render.com/pricing), [Amazon RDS](https://aws.amazon.com/rds/postgresql/pricing/), [Amazon SES](https://aws.amazon.com/ses/pricing/). Costs at larger scale: email in [ADR 0006](adr/0006-email-for-invitees-push-cannot-reach.md#options); infrastructure grows with the stages in the [scaling plan](04-scaling-plan.md).

## The work, in order

1. **Can start before any decision:** error tracking (Sentry); a scan that stops passwords and keys being committed; account deletion; a way to make old app versions ask to update; Apple and Google push keys for the store builds. **As soon as the email provider is chosen:** the provider and its domain, so warm-up starts early, then verifying email addresses at sign-up (unless question 3 below makes it unnecessary).
2. **After hosting:** the deploy pipeline and one rehearsed rollback, backups with a timed restore, alerts that wake the on-call phone, stopping email to addresses that bounce or complain, the link domain with its app-association files and the page for people without the app; reporting and blocking (less of it if the message waits).
3. **Before the first member:** test emails to Gmail, Outlook, iCloud and Yahoo, legal sign-off, the readiness review run again, then a phased release to a small group.

## Questions that would shape it

1. Does the company already run a backend or an analytics tool? Where?
2. Where is the company established, and where are the first members? That decides which email and privacy rules apply first.
3. Is there an existing sign-up that already verifies email addresses? If so, Invites reuses it instead of building its own.
4. How many members would use it in the first month?
5. Who could be second on call?
