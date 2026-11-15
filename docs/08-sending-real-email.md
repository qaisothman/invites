# Sending real email

Invitation emails are designed, built and covered by end-to-end tests against a fake provider ([ADR 0006](adr/0006-email-for-invitees-push-cannot-reach.md)). Until a provider is connected, `EMAIL_DRIVER=log` writes each one to the log: outside production the whole email, with the unsubscribe token cut; in production only the masked address and the subject. Everything below has to be true before an invitation email reaches a real person.

## 1. Provider

- [ ] **Pick one.** Amazon SES costs the least (about $0.10 per 1,000). Postmark and Resend cost more (about $0.40 to $1.70 per 1,000 at 50,000 a month) and give better tooling out of the box. Any of the three fits.
- [ ] **Connect it.** Add its `EmailSender` class in `notifications/providers`, add its name to `EMAIL_DRIVER`'s allowed values in `config/env.validation.ts`, and return it from the `EMAIL_SENDER` factory in `NotificationsModule`. It sends from `EMAIL_FROM`, the `from` of every `EmailMessage`. Nothing else changes.
- [ ] **Keep transactional mail on its own stream,** separate from any future marketing mail. That means a separate stream or configuration set, From address and subdomain. Complaints about marketing must never hurt delivery of invitations.
- [ ] **SES only:** new accounts start in a sandbox, sending only to verified addresses at up to 200 a day. Request production access early.

## 2. Domain authentication

Gmail, Yahoo and Outlook.com reject or junk mail that fails these checks.

- [ ] **Send from a subdomain,** for example `notify.<domain>`. Set `EMAIL_FROM` to an address on it.
- [ ] **Authenticate it:** SPF, and DKIM with 2048-bit keys. The DKIM signature covers `List-Unsubscribe` and `List-Unsubscribe-Post`, as RFC 8058 requires for one-click unsubscribe.
- [ ] **Publish DMARC** aligned with the From domain. Start at `p=none` with reports, then tighten.
- [ ] **Know the bulk limits.** At 5,000 or more messages a day to Gmail or Outlook.com, both treat you as a bulk sender. For Gmail that status is permanent, and a subdomain's volume counts toward the parent domain.
- [ ] **Keep the spam-complaint rate below 0.1%.** At 0.3% Gmail stops helping with delivery problems.
- [ ] **Set `API_PUBLIC_URL` to the API's public https origin.** Every stop link and `List-Unsubscribe` header is built from it. The API refuses to start in production unless it's https.
- [ ] **Keep the one-click unsubscribe headers.** Each email already carries `List-Unsubscribe` and `List-Unsubscribe-Post`. Gmail and Yahoo require them only for marketing, but they lower complaints on any mail.
- [ ] **If the app offers Sign in with Apple,** register the sending domain under Apple's private email relay. Otherwise mail to `@privaterelay.appleid.com` addresses bounces.

## 3. Bounces and complaints

- [ ] **Verify the address before the first invitation email.** Sign-up doesn't verify addresses, so someone could sign up with an address that isn't theirs. Send a one-time link at sign-up, and have the emailer skip members who haven't used it.
- [ ] **Take the provider's bounce and complaint webhooks.** Stop emailing an address that hard-bounces or complains, without touching the member's own switch: record a suppression (for example `users.email_suppressed_at` and a reason), separate from `invitation_emails`. The emailer skips suppressed addresses, and the support trace shows the suppression.
- [ ] **Watch the provider's thresholds.** SES puts an account under review at 5% bounces or 0.1% complaints.
- [ ] **Read Gmail complaints in Google Postmaster Tools.** Gmail reports them only there, not to the provider.

## 4. Warm-up

- [ ] **Ramp up slowly.** A new domain, or a dedicated IP, starts slow: low volume to engaged recipients first, rising over a few weeks. The one-a-day cap keeps volume modest from the start.

## 5. Terms, privacy notice and law

- [ ] **Terms of service:** say that invitations may be delivered by email when push can't reach the member. CAN-SPAM's transactional category rests on that agreement.
- [ ] **Privacy notice:** name the purpose (telling members about invitations push can't deliver) and the lawful basis (legitimate interests). Record the legitimate-interests assessment.
- [ ] **The provider is a processor.** Sign its data processing agreement. Send from a UK or EU region (SES has eu-west-2, London), or record the transfer safeguard. Name the provider as a recipient in the privacy notice.
- [ ] **Right to object:** the opt-out link and the Profile switch honour it.
- [ ] **Complaints:** have a procedure for data-protection complaints (a UK requirement added by the Data (Use and Access) Act 2025), and point to it from the privacy notice.
- [ ] **Footer and replies:** put the company's legal name and registered address in the footer, and set a Reply-To someone reads.
- [ ] **Keep it a service message.** It carries the invitation only: no promotion, no "come back", no reminders. Any change to the wording gets checked against [ADR 0006](adr/0006-email-for-invitees-push-cannot-reach.md) first. Under the UK rules, from 5 Feb 2026, marketing sent as "service" email risks a fine of up to £17.5m or 4% of turnover.
- [ ] **Any future marketing email is a separate project.** In the UK and EU it needs consent; the soft opt-in needs a sale, which a free app doesn't have. In the US it needs CAN-SPAM's opt-out and a postal address. Its unsubscribe must work without signing in.
- [ ] **EU users:** each country's own email law applies to its residents, and where the company is actually run from matters. Get local advice before serving EU members.

## 6. Before the first real email

- [ ] **Send to seed inboxes** at Gmail, Outlook.com, iCloud and Yahoo. Check `Authentication-Results` (SPF, DKIM and DMARC pass) and that the email lands in the inbox.
- [ ] **Tap the invitation link on a phone with the app installed.** It must open the invitation through the universal link (`APP_LINK_BASE/i/<id>`).
- [ ] **Serve a page at `APP_LINK_BASE/i/<id>` for people without the app:** who invited them, and links to the app stores. Check it in a desktop browser and on a phone without the app.
- [ ] **Unsubscribe from a mail app's one-tap button,** then check that `invitation_emails` is false.
- [ ] **Watch `invitation_emails_total{outcome}`** and the email alerts, `InvitationEmailSurge`, `InvitationEmailFailures` and `InvitationEmailsStalled` ([SLOs and alerts](06-slos-and-alerts.md)), for the first week.
