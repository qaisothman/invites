# ADR 0005: Short access tokens, rotating refresh tokens with reuse detection

**Status:** accepted · **Date:** 2026-11-13

## Context
The only client is a phone app that stays signed in for weeks and calls the API on bad connections. A copied long-lived token must be detectable, and a lost response must not sign anyone out.

## Decision
- **Access token:** a JWT (HS256), 15 minutes, carrying only `sub` and `role`. Verified by a global guard on every request without a database lookup.
- **Refresh token:** 32 random bytes, 30 days, stored only as a SHA-256 hash in `sessions`. Every refresh revokes the token used and issues a new one in the same family.
- **Reuse detection:** if a revoked token is presented again, someone has a copy, so the whole family is revoked and that sign-in ends. Revoke-and-check is one conditional `UPDATE`, so of two concurrent refreshes with the same token only one rotates it.
- **Grace window for a lost response:** if the server rotates a token but the response never reaches the phone, the phone's next refresh presents the previous token. Without a grace rule that looks like theft and signs the user out. So the previous token is accepted again for `REFRESH_GRACE_SECONDS` (10) after its rotation, **if its successor has never been used**. The unused successor is revoked and replaced, so a family never has more than one live token. Each row records its successor in `sessions.replaced_by`, written in the same `UPDATE` that revokes it. Retries of one token lock its row first (`SELECT … FOR UPDATE`) and take turns, so five racing refreshes all succeed and still leave one live token (tested).
- **Passwords:** Node's built-in `crypto.scrypt` (N = 2^15, r = 8, p = 1, about 32 MB per hash), compared in constant time. The parameters are stored in each hash, so the cost can rise later without breaking old hashes. When the email doesn't exist, login still checks the submitted password, against a dummy hash made at boot, so login is not a way to test which emails are members.
- **Secure by default:** every route requires a token unless marked `@Public()`.
- **Signed tokens where there is no session:** the delivery ack (`POST /notifications/:id/ack`, ADR 0003) and the unsubscribe link in an invitation email (`/emails/unsubscribe`, ADR 0006) are public routes that take a signed token instead of a session. The token is an HMAC under a key derived from `JWT_SECRET` for that purpose only, never the JWT key itself, and does one thing: mark one notification delivered, or turn one person's invitation emails off.

## Trade-offs
- Revoking stops at the refresh token. After a sign-out, a detected reuse or a role change, an access token already issued keeps working until it expires, up to 15 minutes. Acceptable here; a deny-list checked by the guard would close it if needed.
- **Sign-up and the invite lookup still say whether an address is a member.** `POST /auth/register` answers `email_taken`, and `GET /users/lookup` finds a member by exact email because inviting needs it (signed-in callers only, rate-limited). Closing sign-up needs verified addresses ([production readiness](../09-production-readiness.md#the-gate), row 15): answer "check your inbox" either way.
- **`JWT_SECRET` also keys the signed tokens.** Rotating it invalidates the ack tokens in pushes not yet confirmed and the unsubscribe links in emails already sent (opening one shows a page saying the link no longer works, and a mail app's one-tap POST gets `invalid_link`; the Profile switch still works).
- **The grace window is a 10-second hole in reuse detection.** Someone holding a copy of a token that was rotated less than 10 seconds ago, whose successor is unused, gets a valid token. The two holders then keep replacing each other's token until one of them presents a token more than 10 seconds after it was replaced; that is treated as reuse and ends the sign-in for both. The window is short because a lost response is retried within seconds. A retry after more than 10 seconds still signs the user out, which is the cost of keeping the window small. The app makes concurrent refreshes rare anyway: its refreshes are single-flight, and background push confirmations don't refresh at all (ADR 0003).
- Hashing is bounded by libuv's thread pool (4 threads by default, `UV_THREADPOOL_SIZE` raises it), not by the event loop. `bcryptjs`, measured as the alternative at cost 12, managed 3 logins a second with a 2.5-second median: it hashes in JavaScript on the main thread, so every login blocks every other request. See the [HTTP benchmark](../benchmarks/README.md).
- **The default cost is below OWASP's minimum for scrypt.** N = 2^15 with p = 1 uses 32 MB; OWASP's minimum at that memory is p = 3, or N = 2^17 with p = 1, which `PASSWORD_HASH_COST=17` sets with no code change, at 128 MB and four times the work per hash. The benchmark's login figure was measured at 15. Old hashes keep verifying when the cost rises, because the parameters are stored in each hash.

## Alternatives
- **A managed auth service.** Less code to own; a second system in the sign-in path, and the ack and unsubscribe tokens would still be ours. The first thing to revisit if the company already has a sign-up ([What production would take](../12-what-production-would-take.md#questions-that-would-shape-it), question 3).
- **Server-side sessions** (an opaque token looked up on every request). Revocation is immediate; every request costs a database read.
- **One long-lived JWT.** Simplest; a copied token works until it expires and can't be revoked.

## When to revisit
- A web client arrives: refresh tokens move to an httpOnly cookie for it.
- A sign-out, a detected reuse, a role change or a ban has to take effect at once: add a deny-list checked by the guard.
- `JWT_SECRET` needs routine rotation: give each kind of signed token its own secret, independent of `JWT_SECRET`, and put a key id in the token, so rotating one breaks nothing else.
