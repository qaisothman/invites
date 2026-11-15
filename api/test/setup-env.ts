// End-to-end tests run against their own database.
// Values set here win over .env, because ConfigModule never overwrites a
// variable that already exists.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgres://localhost:5432/nest_invites_test',
  JWT_SECRET: 'test-secret-that-is-at-least-32-characters',
  PASSWORD_HASH_COST: '10', // fast hashing in tests; production uses 15
  THROTTLE_PER_MINUTE: '100000',
  AUTH_PER_MINUTE: '100000',
  LOG_REQUESTS: 'false',
});
