# ADR 0006: Email, not SMS, for invitees push can't reach

**Status:** accepted · **Date:** 2026-11-15

## Context
- **Push doesn't reach everyone.** A new app's users split roughly in half on notifications: Airship's 2025 benchmark puts the median opt-in at 49% on iOS and 53% on Android. Others turn notifications off later, uninstall, or leave the app unused until Android hibernates it, which resets its permissions after a few months.
- **The server can't see any of this from push results.** Apple, Google and Expo accept a push for a phone with notifications off and report success. Only the app knows, so it reports its state (`allowed`, `not_asked` or `off`) with `POST /devices { notifications }`: on launch, on a new token, and on returning to the foreground when the state changed or 15 minutes have passed.
- **An invitation nobody hears about is the funnel's biggest leak, and it hides.** In the numbers it looks like the invitee said no. Measuring it separately is half of the fix.
- **Every member has an email address**, because sign-up needs one. Not every member has a phone number, and nothing else in the product needs one.

## Options

| | Reaches | Cost per message | Rules | Abuse |
|---|---|---|---|---|
| Push only | Members with a phone that can show it | Free | The OS prompt | Low |
| SMS | Members who give a number | About $0.012 to a US number, $0.056 to a UK one, plus US carrier registration (A2P 10DLC) | Per-country consent and opt-out | SMS pumping: attackers trigger texts to premium-rate numbers |
| Email | Every member | About $0.0001 (Amazon SES, $0.10 per 1,000) | An opt-out, a line in the terms and the privacy notice ([Sending real email](../08-sending-real-email.md)), if it carries only the invitation | Sign-up doesn't verify addresses, so someone could have an invitation emailed to an address that isn't theirs. Display names can't carry links (`http:`, `https:`, `www.` or a domain followed by a path, full-width look-alikes included), control characters, line breaks or characters that hide or reorder text; a bare domain still passes. Capped at one email a day per address and by `INVITES_PER_HOUR`. [Sending real email](../08-sending-real-email.md) requires verifying the address before the first invitation email |

An estimate of the bill: given the opt-in rate, at most about half of invitations go to email. At 10,000 members (1,000 invitations a day, [Scaling plan](../04-scaling-plan.md)) that's about 15,000 emails a month, or $1.50 on SES. At 1,000,000 members (100,000 a day) it's about 1.5 million a month, or $150. The same 1.5 million by SMS would cost about $18,000 a month at US rates.

SMS costs about 120 to 560 times more per message than email, needs registration and per-country consent, and invites fraud. It's the right channel for some products (an event app that invites people by phone number), but not for members who already gave an email address.

## Decision
1. **Push first, email second, never both.** A notification goes to every phone of the invitee's that can show it. Only when none can does the invitee get an email.
2. **"Can show it" comes from the phone's own reports.** A phone counts when it's signed in, its last report said `allowed`, and it isn't an Android phone silent for 90 days (hibernated). The dispatcher pushes only to those, because a push to the rest succeeds everywhere and reaches no one. With none, the notification is `unreachable`. A push that failed for good (`failed`) counts the same; one withdrawn because the invitation closed before it went out (`withdrawn`) is never emailed.
3. **The trigger is reachability, not a missing delivery ack.** Acks are best effort in both directions: iOS can wake the app for a push it won't show, and Android can show a push without running any app code. A rule built on "no ack after N minutes" would email people who saw the push and miss people who didn't.
4. **The rule** (`InvitationEmailer`, every minute). An invitation notification is emailed when all of these hold:
   - it's `unreachable` or `failed`;
   - it's at least `EMAIL_AFTER_SECONDS` old (15 minutes), so an invitee using the app at the time sees it there first;
   - it's younger than `INVITE_TTL_DAYS`, the longest an invitation lives, so the scan reads only that span of the index however large the table grows;
   - the invitation is still pending, unexpired and unopened;
   - the invitee hasn't turned invitation emails off.

   Each person gets at most one email a day, and everything waiting for them goes into it. Claiming the person's row (`users.last_invitation_email_at`) enforces the limit even with several workers. A provider error is retried per invitation, 5, 10, 20 and 40 minutes after each attempt, up to five attempts in all, and a refused send releases the person's day, so neither the retry nor their next invitation waits 24 hours. So does a claim that finds nothing of theirs left to send (answered or seen since they were picked): the day is given back in the same transaction that took it. A claim not settled within 10 minutes (the worker died mid-send) is claimed again. As with push ([ADR 0003](0003-at-least-once-delivery.md)), a rare duplicate email beats a lost invitation.
5. **A service message, never marketing.** The email says who invited them, links to the invitation, says when it expires and why they're getting it. There's no message text and no photo, because inboxes are shared and previews show on lock screens. There's nothing promotional and there are no reminders. "We miss you" or "people are waiting" would be direct marketing under UK and EU rules (consent needed) and commercial email under CAN-SPAM. Every email carries a "stop these emails" link that needs no sign-in, plus `List-Unsubscribe` headers for one-tap unsubscribe in mail apps. The same switch is in Profile.
6. **No tracking pixel.** The funnel already counts the tap through the app (`opened`). Per-person open tracking needs consent in the UK and EU, and Apple's Mail Privacy Protection inflates opens anyway.
7. **The provider sits behind an interface** ([ADR 0004](0004-providers-behind-interfaces.md)). Until one is connected, `EMAIL_DRIVER=log` writes each email to the log. [Sending real email](../08-sending-real-email.md) lists what a real provider needs.

## Consequences
- **The funnel separates plumbing from product.** `dropOff.unreachable` counts invitations that stopped there. `email.sent` and `email.optedOut` count what the emailer did. `email.openedAfter` and `email.acceptedAfter` count invitations opened or accepted after their email, which says whether the second channel pays off.
- **`device_reports_total{notifications="off"}` by app version** catches a release that breaks the permission prompt.
- **Push follows the same content rule:** the inviter's name and nothing else. The message stays in the app.
- **An Android phone quiet for 90 days but still able to show a push gets an email instead.** That mistake is cheap and errs on the safe side.
- **`notifications` is optional on `POST /devices`** and defaults to `allowed`, so a report without it counts as a phone that can show the push.
- **A known limit:** a phone whose user turns notifications off in Settings and never opens the app again keeps its last `allowed` report. On iOS nothing ages it out, so its pushes reach no one and no email follows until the app next opens.
- **Deliberately not built:**
  - SMS;
  - email for "your invitation was accepted" (the inviter will see it in the app);
  - reminders before an invitation expires;
  - invitations to people who aren't members, because that email would be the company's marketing.

## When to revisit
- Spam complaints above 0.1%, or `email.openedAfter` near zero after a month: the email is hurting more than helping.
- Invitations to people who aren't members yet: that email is marketing, and needs consent.
- A product that invites by phone number, where SMS is the only channel that reaches the invitee.
- Apple or Google give the server a way to see whether notifications are on, which would remove the app's report.
- On iOS, delivered over sent falls while sent holds steady ([risk 4](../10-risks.md)): age out iOS `allowed` reports the way Android's are.
- The ICO publishes its updated direct-marketing guidance after the Data (Use and Access) Act 2025: check the service-message reasoning in decision 5 against it.

## Sources
- Airship, [Mobile app push notification benchmarks for 2026](https://www.airship.com/mobile-app-push-notification-benchmarks-for-2026/) (March 2026, 2025 data).
- Android, [App hibernation](https://developer.android.com/topic/performance/app-hibernation) (updated 28 Oct 2026).
- Apple, [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) 4.5.4 and 5.1.1(iv) (updated 16 Oct 2026).
- Twilio, SMS pricing for the [US](https://www.twilio.com/en-us/sms/pricing/us) and the [UK](https://www.twilio.com/en-us/sms/pricing/gb) (November 2026); Amazon, [SES pricing](https://aws.amazon.com/ses/pricing/) (2026).
- ICO, [Identify direct marketing](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/direct-marketing-guidance/identify-direct-marketing/) (updated 28 Apr 2026); FTC, [CAN-SPAM Act: a compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) (January 2024).
- Meetup, [How Meetup notifications work](https://help.meetup.com/hc/en-us/articles/40705340432525-How-Meetup-notifications-work) (updated 11 Nov 2026): push first, email about 15 minutes later.
