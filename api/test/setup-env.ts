// End-to-end tests run against their own database.
// Values set here win over .env, because ConfigModule never overwrites a
// variable that already exists.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgres://localhost:5432/nest_invites_test',
  JWT_SECRET: 'test-secret-that-is-at-least-32-characters',
  LOG_REQUESTS: 'false',
});
