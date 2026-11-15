# Releases and database migrations

## Backend release, in order

1. CI is green on the commit: types, lint, unit, end-to-end against Postgres, the schema-drift check, and the image build.
2. Run the **migrate** job with the new image (`npm run migration:run:prod`). It runs before any new code serves traffic.
3. Roll the **API** instances (readiness probe gates traffic; old instances get SIGTERM, finish in-flight requests, and exit).
4. Roll the **worker** instances (SIGTERM stops new batches; the current batch finishes; leases cover anything cut short).
5. Watch dispatch outcomes, outbox age and the API error rate for 15 minutes. Roll back by redeploying the previous image; migrations stay.

## Migrations: expand, then contract

The old code and the new code run side by side during a rollout, so every migration must work with both. Never rename or drop in one step.

| Change | Release 1 (expand) | Release 2 | Release 3 (contract) |
|---|---|---|---|
| Rename a column | add the new column; write both | backfill; read the new one | drop the old one |
| Add a NOT NULL column | add it nullable with a default | backfill | add NOT NULL |
| Add an index on a big table | `CREATE INDEX CONCURRENTLY` in its own migration (`transaction = false`; migrations run one transaction each, and the migration CLI has no statement timeout) | | |
| Add an enum value | `ALTER TYPE ... ADD VALUE` (can't run in a transaction before Postgres 12) | start using it | |

Rules:
- Every migration is generated from the entities (`npm run migration:generate`), read by a person, and committed.
- CI fails if the entities and the migrations disagree (`migration:generate --check`).
- `synchronize` is off in every environment.
- Long data backfills run as jobs in batches, not inside a migration.

## Mobile release

- Builds via EAS, with development, preview and production profiles. A cloud build needs `APP_ID`, `APPLE_TEAM_ID` and `EAS_PROJECT_ID` as EAS environment variables, since `.env` isn't uploaded ([app README](../app/README.md#layout)).
- OTA updates (`eas update`; needs `expo-updates`, which isn't installed yet) for JavaScript-only changes; a store release for native changes (new modules, permissions, SDK upgrades).
- The API stays backward compatible with every app version in use: add fields, never remove or repurpose them. The `appVersion` on each device row shows which versions are active. `notifications` is optional on `POST /devices` and defaults to `allowed`, so a client that doesn't send it keeps working.
- After a release, compare the share of `device_reports_total{notifications="off"}` for the new `app_version` with the others. Only a plain `x.y.z` version becomes a label; anything else is `other`. A jump means the release broke the permission prompt or the Android "Invitations" channel, and its users get emails, not pushes ([invitation email surge](05-runbook.md#email-surge)).
