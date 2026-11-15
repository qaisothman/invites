# Run and test it locally

Everything runs on one machine: Postgres in Docker, the API and its workers in one Node process. Push goes through a fake provider, and invitation emails are written to the API's log, so no accounts or keys are needed. About 15 minutes from a fresh clone to every path in steps 1 and 2.

## What you need

- Node 24 (`.nvmrc`), Docker, `curl` and `jq` (`brew install jq`; macOS 15 and later ship it).

Every command block below can be pasted as it is into a terminal, one block at a time. Each says where it runs.

## 1. Start it

In a terminal at the repo root.

**If Postgres already runs on this machine,** port 5432 is taken, and the API would connect to that Postgres instead of this one. Give this guide's database port 5433 first. Docker Compose reads it from `.env` at the repo root, so it holds in every terminal and every later step:

```bash
echo DB_PORT=5433 >> .env
```

Then, either way:

```bash
docker compose up -d --wait db
sed "s/localhost:5432/$(docker compose port db 5432)/" api/.env.example > api/.env
cd api
npm ci
npm run migration:run
npm run start:dev
```

That is Postgres 16 in Docker, and the API with its background workers in one process. `--wait` returns once Postgres accepts connections. The `sed` line copies `api/.env.example` to `api/.env` with the database's address, `127.0.0.1:5432` or `127.0.0.1:5433`. `.env.example` is set up for this guide: port 3100, a fake push provider that accepts every push without sending it, and a 20-second wait before an invitation email instead of 15 minutes, so you can watch it happen.

When it's up, `curl localhost:3100/health/ready` answers `{"status":"ok"}`, and the API explorer is at http://localhost:3100/docs.

## 2. Try it from a second terminal

Open it at the repo root. These helpers are used by every step below:

```bash
API=http://localhost:3100
call() { token=$1; shift; curl -s -H "authorization: Bearer $token" -H 'content-type: application/json' "$@"; }
signup() { curl -s $API/auth/register -H 'content-type: application/json' \
  -d "{\"email\":\"$1@example.com\",\"password\":\"correct horse battery\",\"displayName\":\"$2\"}"; }
login() { curl -s $API/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$1@example.com\",\"password\":\"correct horse battery\"}" | jq -r .accessToken; }

A=$(signup alice Alice); ALICE=$(echo "$A" | jq -r .accessToken)
B=$(signup bob Bob);     BOB=$(echo "$B" | jq -r .accessToken); BOB_ID=$(echo "$B" | jq -r .user.id)
C=$(signup carol Carol); CAROL=$(echo "$C" | jq -r .accessToken)
```

Access tokens last 15 minutes. If answers turn into `null`, sign in again: `BOB=$(login bob)`, and the same for `ALICE` and `CAROL`.

### Bob's phone can show the push

```bash
call $BOB $API/devices -d '{"expoPushToken":"ExponentPushToken[bob-iphone]","platform":"ios","notifications":"allowed"}' | jq -c .
INV=$(call $ALICE $API/invitations -d "{\"inviteeId\":\"$BOB_ID\",\"message\":\"Coffee on Friday?\"}" | jq -r .id)
sleep 2
call $BOB $API/notifications | jq -c '.items[0] | {title, body, status}'
```

The dispatcher runs every second, hence the pause. The last line prints `{"title":"Alice invited you","body":"Tap to see the invitation","status":"sent"}`. The push names the inviter and nothing else; the message stays in the app.

Now be Bob's phone: confirm it arrived, tap it, accept.

```bash
NID=$(call $BOB $API/notifications | jq -r '.items[0].id')
call $BOB -X POST $API/notifications/$NID/delivered -w '%{http_code}\n'
call $BOB -X POST $API/notifications/$NID/opened -w '%{http_code}\n'
call $BOB -X POST $API/invitations/$INV/accept | jq -c '{status}'
```

That prints `204`, `204` and `{"status":"accepted"}`.

### Bob turns notifications off: the email

```bash
call $BOB $API/devices -d '{"expoPushToken":"ExponentPushToken[bob-iphone]","platform":"ios","notifications":"off"}' | jq -c .
call $CAROL $API/invitations -d "{\"inviteeId\":\"$BOB_ID\"}" > /dev/null
sleep 2
call $BOB $API/notifications | jq -c '[.items[] | {title, status}]'
```

Carol's invitation is `unreachable`: no phone of Bob's can show it, so nothing is pushed. Within 20 to 80 seconds (the 20-second wait, then the emailer's next one-minute cycle), the API's terminal shows the email:

```
… LOG [Email] to b•••@example.com: Carol invited you
Carol invited you on Invites.

Open the invitation: https://invites.example.com/i/<invitation id>
It expires in 14 days.

You're getting this email because Invites can't reach your phone with a notification. Stop these emails: http://localhost:3100/emails/unsubscribe?u=<Bob's id>&t=…
```

The log masks the address and cuts the link's signature.

Invite Bob again from Alice (her first invitation is answered, so a new one is allowed). No second email comes today: the new invitation waits for tomorrow's email, which carries everything waiting.

```bash
call $ALICE $API/invitations -d "{\"inviteeId\":\"$BOB_ID\"}" > /dev/null
```

### Stop the emails from the link

The link is signed per person, so it works without signing in. Build Bob's the way the API does:

```bash
LINK=$(node -e '
  const c = require("crypto"), [secret, user] = process.argv.slice(1);
  const key = c.createHmac("sha256", secret).update("email-unsubscribe-v1").digest();
  const t = c.createHmac("sha256", key).update(user).digest("base64url");
  console.log(`http://localhost:3100/emails/unsubscribe?u=${user}&t=${t}`);
' "$(grep '^JWT_SECRET=' api/.env | cut -d= -f2)" "$BOB_ID")
echo "$LINK"
```

Open the printed link in a browser (`open "$LINK"` on macOS). It shows a page with one button, and opening it changes nothing, because mail scanners open links on their own. The button sends a POST, which is also what a mail app's one-tap unsubscribe sends:

```bash
curl -s -X POST "$LINK" > /dev/null
call $BOB $API/users/me | jq -c '{invitationEmails}'
curl -s -X POST "${LINK%t=*}t=forged-forged-forged-forged" | jq -c .error.code
```

That prints `{"invitationEmails":false}`, then `"invalid_link"` for the forged link. The same switch is `PATCH /users/me {"invitationEmails": true}`.

### The funnel and the support trace

Both are admin-only. Make Alice an admin and sign in again (the role is in the token):

```bash
docker compose exec db psql -U postgres nest_invites -c "UPDATE users SET role = 'admin' WHERE email = 'alice@example.com'"
ALICE=$(login alice)

TODAY=$(date -u +%F); TOMORROW=$(date -u -v+1d +%F 2>/dev/null || date -u -d tomorrow +%F)
call $ALICE "$API/admin/funnel/invitations?from=$TODAY&to=$TOMORROW" | jq .
call $ALICE "$API/admin/users/$BOB_ID/notification-trace" | jq '.devices, [.notifications[] | {title, status, emailStatus, attempts}]'
```

The funnel shows each step from created to accepted, the drop-off (here `unreachable`: Carol's invitation, and Alice's second), and the email's results. The trace is what support reads when someone says "I never got it": each phone with its notifications state, and each notification's push attempts and email status.

Prometheus metrics are at http://localhost:3100/metrics: `notifications_dispatched_total`, `invitation_emails_total`, `device_reports_total` and the rest. There, `unreachable` counts Alice's "Bob accepted" notification too, since Alice has no phone registered.

## 3. Run the tests

In the second terminal, at the repo root. The block creates the test database and runs the API's unit and end-to-end tests against it:

```bash
docker compose exec db createdb -U postgres nest_invites_test
export TEST_DATABASE_URL=postgres://postgres@$(docker compose port db 5432)/nest_invites_test
cd api
npm test
npm run test:e2e
cd ..
```

That is 43 unit tests and 69 end-to-end tests.

The end-to-end suite boots the real API against Postgres, with only the push and email providers faked. One test makes the outbox fail on purpose, so an `outbox unavailable` error with a stack trace in the output is expected. It covers what the steps above can't trigger by hand: an Expo outage and its retries, broken push credentials, an uninstalled app, receipt errors, an invitation withdrawn while its push waited, a crashed worker's lease and email claim, four dispatchers racing over one outbox, a refresh response lost on the way to the phone, an email the provider refused five times, and the rate limits. The [root README](../README.md#test-it) lists them all.

## 4. Optional

**Benchmarks.** They need the database from step 1 running, and create and migrate their own database beside it, `nest_invites_bench` ([what they measure](benchmarks/README.md)). In the second terminal, at the repo root:

```bash
export BENCH_DATABASE_URL=postgres://postgres@$(docker compose port db 5432)/nest_invites_bench
cd api
npm run bench:db
npm run bench:dispatch
npm run build && npm run bench:http
cd ..
```

`bench:http` starts the compiled API on port 3200. Each run rewrites its JSON file in `docs/benchmarks/`; `git checkout -- docs/benchmarks` restores the published numbers. Those were measured against a native Postgres 15.14 on one laptop, not this Docker Postgres 16, so expect different absolute figures; the shapes (a flat claim with the partial index and a linear one without, throughput growing with loops) are what should match.

**The whole system as it would deploy.** The migrate job, the API and a separate worker from one image, plus Prometheus with the [alert rules](../ops/alerts.yml) on port 9090. Stop the API from step 1 first (Ctrl-C). The stack's API listens on port 3000. If something on this machine already uses 3000, give it 3300 first, the same way as the database port:

```bash
echo API_PORT=3300 >> .env
```

Then, in the first terminal, `cd ..` to the repo root and run:

```bash
docker compose --profile stack up --build
```

It stays in the foreground. It is up once the log shows `migrate-1 exited with code 0`, then `Workers started` from `worker-1`. From the second terminal, at the repo root, this answers `{"status":"ok"}` on whichever port the API got:

```bash
curl -s "localhost:$(docker compose port api 3000 | awk -F: '{print $NF}')/health/ready"
```

http://localhost:9090/alerts lists the 9 alert rules, and http://localhost:9090/targets shows `api` and `worker` up. The stack uses the same database as step 1, so its data is there, but this API has its own signing secret: tokens and links from step 2 don't work against it. Ctrl-C stops every container of the stack, the database's included; `docker compose up -d --wait db` starts the database again, with its data.

## Start again

To start over with empty databases, stop the API or the stack with Ctrl-C. In the first terminal, at the repo root:

```bash
docker compose --profile stack down -v
docker compose up -d --wait db
cd api
npm run migration:run
npm run start:dev
```

`down -v` removes this guide's containers, their network and the database volume: the development, test and bench databases all go. `api/.env` and the ports in `.env` stay. Step 3's block creates the test database again.

## Clean up

Stop the API and the stack (Ctrl-C in each), then at the repo root:

```bash
docker compose --profile stack down -v
rm -f .env api/.env
git checkout -- docs/benchmarks
```

That removes the containers, their network, the database volume, and the two `.env` files this guide wrote. If you ran the stack, this removes the image it built:

```bash
docker image rm invites-api:local
```

Docker keeps the `postgres` and `prom/prometheus` images it downloaded. `node_modules` in `api/` and `api/dist` are ignored by git; delete them to reclaim the space.
