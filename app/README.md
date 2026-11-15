# Invites app

The mobile client for the API in `../api`: sign in, invite someone by email,
answer the invitations you receive, and get a push when it happens.

Expo SDK 58, React Native 0.88 (New Architecture), expo-router, TanStack
Query. No UI kit: `StyleSheet`, the system font, one accent colour, light and
dark mode. The icon and splash screen are the Expo template's art.

## Run it against the local API

Start the API on port 3100 first: step 1 of [Run and test it locally](../docs/00-run-and-test-locally.md). Then, from here:

```bash
npm ci
npx expo run:ios
```

Or `npx expo run:android`. Copying `.env.example` to `.env` is optional: the
default API address is `http://localhost:3100`.

`expo run:*` generates the native projects (`ios/`, `android/`, not
committed), builds a development build (`expo-dev-client`) and starts Metro.
After the first build, `npx expo start` is enough until a native dependency
or `app.config.ts` changes.

`npx expo start --go` runs the same JS in Expo Go, which is enough to try
every screen, but Expo Go can't receive real remote push for this app.

> **Xcode 26.2:** Swift 6.2 rejects one line in SDK 58's `expo-modules-jsi`
> (`sending 'slot' risks causing data races`; newer compilers accept it).
> `patches/expo-modules-jsi+58.0.23.patch` passes that pointer across the
> isolation boundary as an integer instead, with the same behaviour, and
> `patch-package` re-applies it on every `npm install`. Compiling the module in
> Swift 5 mode doesn't work: it uses Swift 6-only features. Delete the patch when
> Expo ships a fixed version or the toolchain moves on. CocoaPods also needs a
> UTF-8 locale (`export LANG=en_US.UTF-8`).

The iOS Simulator reaches the API at `localhost`. An Android emulator needs
`EXPO_PUBLIC_API_URL=http://10.0.2.2:3100`; a phone needs your Mac's LAN IP.

```bash
npm test
npm run typecheck
npx expo-doctor
```

`npm test` runs 18 Jest tests (jest-expo): the API client's refresh, errors
and 15-second timeout, a stalled body included; the notifications state; the
inbox prompt, including a refused OS prompt quieting it for 7 days; and late
acks. `typecheck` is `tsc --noEmit`, and `expo-doctor` checks dependencies and
config.

## Layout

```
index.ts                     entry: defines the background push task, then loads the router
app.config.ts                app config: bundle id, scheme, universal/app links, plugins
eas.json                     EAS Build profiles (not used by this demo; a cloud build needs
                             APP_ID, APPLE_TEAM_ID and EAS_PROJECT_ID as EAS environment
                             variables, since `.env` isn't uploaded)
src/app/                     screens (expo-router: one file per route)
  _layout.tsx                providers, session gate (Stack.Protected), push wiring
  sign-in.tsx                sign in / create account
  (tabs)/                    Received, Sent, Invite, Profile (native tab bar)
  i/[id].tsx                 one invitation: accept, decline, cancel
src/api/
  client.ts                  fetch wrapper: ApiError, single-flight token refresh, 15 s timeout
  index.ts                   one typed function per endpoint
  queries.ts                 TanStack Query client, keys and hooks
  types.ts                   response shapes (from api/src)
src/auth/
  session.ts                 tokens: refresh token in SecureStore, access token in memory
  auth.ts                    sign in, register, sign out
src/push/                    everything about push notifications (below)
src/invitations/             the list and its formatting
src/ui/                      theme and the few shared components
```

## Auth

- The refresh token (30 days) is stored with `expo-secure-store` (Keychain /
  Keystore). The access token (15 minutes) only lives in memory.
- Every request goes through `src/api/client.ts`. On a `401 invalid_token` it
  refreshes and retries once. Refreshes are **single-flight**: if five
  requests expire together they share one `POST /auth/refresh`. That matters
  because refresh tokens rotate: parallel refreshes could leave the app holding
  a token the server has already replaced, and presenting that later revokes
  the whole session (`refresh_token_reused`).
- If the server rejects the refresh token, the session is cleared and the root
  layout swaps to the sign-in screen. If the refresh fails for lack of
  network, the session is kept.
- A request with no answer after 15 seconds fails as a network error, so a
  stalled connection can't hold up sign-out or the requests waiting on a
  refresh.

## Push, end to end

```
app                        API                              Expo / APNs / FCM
───                        ───                              ─────────────────
push token +
notifications state ─────► POST /devices (upsert)
                           invitation created
                           └ notification row in the outbox
                             (same transaction)
                           worker sends it ───────────────► push to every phone
                                                            that can show it
push arrives ◄─────────────────────────────────────────────
POST /notifications/:id/ack ───────►  delivered_at
  { token }  (signed, no session needed)
user taps it
POST /notifications/:id/opened ────►  opened_at
                           no phone can show it ──► unreachable
                             └ one email after 15 minutes
```

1. **Notifications state** (`toNotificationsState` in `src/push/push.ts`):
   `allowed` when the OS shows our pushes; `not_asked` when they aren't
   allowed but the OS would still show its prompt; `off` when only Settings
   can turn them on (iOS denied, Android permanently denied, or the Android
   "Invitations" channel blocked). On iOS it reads `ios.status`, so
   provisional authorisation counts as allowed. On Android 13+ a permission
   the app has never asked for reads as `denied` with `canAskAgain`, which is
   `not_asked`.
2. **Permission** is asked after sign-in, from a short prompt at the top of
   the inbox, shown only while the phone can't show our pushes. Its logic is
   `createPushPrompt` in `src/push/push.ts`; `src/push/PushPrompt.tsx` only
   renders it. Never a pop-up on launch and never a gate: the app works
   without push (App Store guideline 4.5.4), and iOS shows its own prompt
   only once.
   - `not_asked`: "Turn on notifications to hear about new invitations right
     away." **Turn on** shows the OS prompt.
   - `off`: "Notifications are off for Invites. Turn them on in Settings…"
     **Open Settings** opens the app's notification settings on Android, and
     the app's page in Settings on iOS.

   Both offer **Not now**. "Not now", or refusing the OS prompt, quiets the
   prompt for 7 days. It re-checks on every return to the foreground, so it
   goes away when the user comes back from Settings with notifications on.
3. **Token and report**: `getExpoPushTokenAsync` needs the EAS `projectId`,
   but not notification permission, on either platform. Without a
   `projectId`, on a simulator without push support, or on Android without
   Firebase, the app logs and skips; everything else works. `POST /devices`
   sends the token, platform, app version and notifications state on every
   launch, again if the token rotates (`addPushTokenListener`), and on each
   return to the foreground when the state changed or the last report is 15
   or more minutes old. The report is the only way the server can know:
   Apple, Google and Expo accept a push for a phone with notifications off
   and report success. The server pushes only to phones whose last report
   said `allowed`, and treats an Android phone silent for 90 days as unable
   to show one (Android hibernates unused apps). Sign-out sends
   `DELETE /devices/:id`. A phone whose session ended without it (expired,
   revoked, or signed out offline) keeps its device row and its pushes until
   someone signs in on it
   ([ADR 0006](../docs/adr/0006-email-for-invitees-push-cannot-reach.md#consequences)).
4. **Delivered**: the server can't know a push reached the phone unless the
   app says so. The app acks from the foreground listener and from a
   background task (`src/push/background-task.ts`), with the `ackToken` each
   push carries: an HMAC of the notification id, so the ack needs no session
   and never races the app's own token refresh. The background path is best
   effort: the server sends every push with `contentAvailable: true`, but iOS
   throttles those wake-ups and skips them for an app the user force-quit; a
   killed Android app only runs it for data-only pushes. So whenever the app
   comes to the foreground it also acks every push of ours still in
   Notification Center (`ackPresented`): late, but true. The background task
   acks only while notifications are allowed, because iOS can wake it for a
   push it won't show. Expo's push receipts cover the rest on the server.
   Whether an invitation is emailed doesn't depend on these acks, only on
   whether any phone of the invitee's could show the push.
5. **Opened**: tapping a push (app running or cold start) acks `opened` and
   opens `/i/<invitationId>`.
6. **Invitation emails**: when no phone of the invitee's can show the push,
   or the push failed for good, the server emails them once it's 15 minutes
   old and the invitation is still pending, unexpired and unopened, at most
   one email per person a day
   ([ADR 0006](../docs/adr/0006-email-for-invitees-push-cannot-reach.md)).
   No email provider is connected: with `EMAIL_DRIVER=log` (the default)
   the API writes each email to its log
   ([Sending real email](../docs/08-sending-real-email.md)). Profile has an
   "Invitation emails" switch, saved as soon as it's flipped
   (`PATCH /users/me { invitationEmails }`). It shows the server's value, so
   an unsubscribe from an email's link shows there too.

## Deep links

- `invites://i/<id>` opens an invitation (custom scheme, works without a domain).
- `https://invites.example.com/i/<id>`, the `url` in every push and the link
  in every invitation email, is set up as an iOS universal link
  (`associatedDomains`) and Android app link (`intentFilters`). For those to
  open the app in production you need the real domain in `app.config.ts`,
  plus `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json` served from it.

Try one on the simulator: `xcrun simctl openurl booted invites://i/<id>`, or
on an emulator: `adb shell am start -a android.intent.action.VIEW -d invites://i/<id>`.

## Real push on an iPhone

Once:

1. **EAS project.** `npx eas-cli@latest init` creates it. `app.config.ts` is
   dynamic, so put the id it prints in `.env` as `EAS_PROJECT_ID`.
2. **`.env`.** `APP_ID`, a bundle id you own; `APPLE_TEAM_ID`, a paid team
   (free teams don't get the push entitlement); and
   `EXPO_PUBLIC_API_URL=http://<the Mac's LAN IP>:3100`. Phone and Mac on the
   same Wi-Fi.
3. **Xcode signed in to that team** (Settings > Apple Accounts), so automatic
   signing can register the App ID with Push Notifications, and the phone.
4. **An APNs key on EAS.** `eas` doesn't read `.env`, so load it first:
   `set -a; . ./.env; set +a; npx eas-cli@latest credentials -p ios`, then
   sign in to Apple > Push Notifications > Set up your project.
   - Apple allows two team-wide APNs keys. If the team already has both,
     generating fails ("maximum allowed number of team scoped Keys"). Create
     one restricted to this app instead: developer.apple.com > Keys > + >
     APNs > Configure, environment **Sandbox**, restriction **Topic
     Specific**, topic = your bundle id. Download the `.p8` (once only), then
     in the same `npx eas-cli@latest credentials -p ios` menu: Push
     Notifications > Add a new push key, answer
     **no** to generating, give the path and Key ID, and choose Use an
     existing push key to assign it. A sandbox key covers development builds;
     TestFlight and the App Store need a production one.

Build and run. The first build has to come from the Xcode app: open
`ios/Invites.xcworkspace`, pick the phone, Product > Run. That creates the
App ID and a development profile with the push entitlement. On Xcode 26.2,
`xcodebuild -allowProvisioningUpdates` can't use the account the Xcode app
signed in with ("No Accounts"), and `expo run:ios --device` doesn't ask for
provisioning updates at all, so both fall back to the team's wildcard
profile, which can't carry push. Once the profile exists, a plain
`xcodebuild` (no `-allowProvisioningUpdates`) finds and uses it.

The first time, run from Xcode (Product > Run on the phone); the debug build
loads its JS from Metro:

```bash
npx expo prebuild --platform ios --clean
open ios/Invites.xcworkspace
npx expo start
```

After that, a Release build embeds the JS and runs without Metro:

```bash
xcodebuild -workspace ios/Invites.xcworkspace -scheme Invites \
  -configuration Release -destination id=<udid> -derivedDataPath build build
xcrun devicectl device install app --device <device-id> \
  build/Build/Products/Release-iphoneos/Invites.app
```

In a second terminal, start the API with the real push driver:

```bash
cd ../api
npm run build
PUSH_DRIVER=expo node dist/main.js
```

`xcrun devicectl list devices` gives the device id; `xcrun devicectl device
info details --device <device-id>` prints the UDID that `-destination` wants.

iOS asks for local-network access on first launch: that's Metro and the API
on the Mac. Push delivery and acks were verified on 14 Nov 2026 on an
iPhone 17 Pro Max (iOS 27.2) with real APNs: token registered; a real push delivered, with the
phone's signed ack recording `delivered_at` 0.4 s after the send; a tap
recorded `opened`. A push shown on the locked phone without waking the app
was confirmed by `ackPresented` when the app was opened 4m46s later.

The notifications report, the inbox prompt and the "Invitation emails"
switch were checked in the iOS Simulator against the local API: the phone
registered as `not_asked`, the switch saved, and two invitations no phone
could show produced one logged email. Unit tests cover which prompt each
state gets (`off` sends to Settings, `allowed` hides the prompt), that a
refused OS prompt quiets it for 7 days, and Android's notification states.

Add `EXPO_ACCESS_TOKEN` to the API if push security is turned on for the Expo
project.

## Android

`npx expo run:android` builds a debug build for an emulator or a phone. Debug
builds allow plain HTTP; a release build would need HTTPS or a cleartext
exception. Push on Android needs Firebase: a `google-services.json`, added to
`app.config.ts` as `android.googleServicesFile: './google-services.json'`, and an FCM V1 service
account key uploaded with
`set -a; . ./.env; set +a; npx eas-cli@latest credentials -p android`. Without
them the app logs `push registration skipped` and everything else works.
