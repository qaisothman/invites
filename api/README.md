# api

NestJS 11 backend. See the [root README](../README.md) and [docs](../docs/02-architecture.md).

| Command | What it does |
|---|---|
| `npm run start:dev` | API and workers in one process, watching for changes |
| `WORKERS_ENABLED=false npm run start:dev` | API only |
| `npm test` / `npm run test:e2e` | unit / end-to-end. The end-to-end suite needs Postgres and a `nest_invites_test` database; with docker compose's db, create it and pass the role as the [root README](../README.md#test-it) shows (`TEST_DATABASE_URL=postgres://postgres@$(docker compose port db 5432)/nest_invites_test`, on whichever port the database got) |
| `npm run migration:generate -- src/database/migrations/Name` | generate a migration from entity changes; read it before committing |
| `npm run migration:run` | apply migrations to `DATABASE_URL` |
| `npm run bench:db`, `npm run bench:dispatch`, `npm run build && npm run bench:http` | the benchmarks in [docs/benchmarks](../docs/benchmarks/README.md); each creates and migrates its own database. With docker compose's db, first `export BENCH_DATABASE_URL=postgres://postgres@$(docker compose port db 5432)/nest_invites_bench` |

Invitation emails go to the log (`EMAIL_DRIVER=log`, the default) until a provider is connected. In production that logs a warning at boot, and `EMAIL_DRIVER=fake` is refused. [Sending real email](../docs/08-sending-real-email.md) lists what a real provider needs.

## Layout

```
src/
  main.ts                 bootstrap: helmet, trust proxy (TRUST_PROXY_HOPS), shutdown hooks, OpenAPI
  app.module.ts           modules + global pipe, filter and guards (APP_*)
  config/                 environment schema, validated at boot
  database/               TypeORM options, naming strategy, migrations
  common/                 request id + logging, error filter, pagination, quotas
  auth/                   JWT + refresh rotation, guards, decorators
  users/ devices/         profiles and the email opt-out; push tokens and notifications state
  invitations/            invitations + the funnel report
  notifications/          outbox, dispatcher, receipts, invitation emails and unsubscribe, push and email providers
  workers/                starts and gracefully stops the background loops
  metrics/                Prometheus registry and /metrics
  health/                 liveness and readiness probes
test/                     end-to-end tests (real Postgres, fake providers)
bench/                    benchmarks
```
