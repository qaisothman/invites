# api

The NestJS backend: configuration validated at boot (`src/config`), schema changes only as migrations (`src/database`), one error shape carrying the request id (`src/common`), and a health check (`src/health`).

| Command | What it does |
|---|---|
| `npm run start:dev` | run it, watching for changes |
| `npm test` / `npm run test:e2e` | unit / end-to-end tests (needs Postgres) |
