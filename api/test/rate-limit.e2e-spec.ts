import request from 'supertest';
import type { TestApp } from './test-app';

// The other suites lift every limit out of reach; this one sets them low.
// AppModule reads the environment when it is first imported, so the app is
// loaded only after the override.
describe('Rate limits (e2e)', () => {
  const saved = {
    AUTH_PER_MINUTE: process.env.AUTH_PER_MINUTE,
    INVITES_PER_HOUR: process.env.INVITES_PER_HOUR,
  };
  let app: TestApp;
  let helpers: typeof import('./test-app.js');
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    Object.assign(process.env, { AUTH_PER_MINUTE: '3', INVITES_PER_HOUR: '2' });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    helpers = require('./test-app') as typeof import('./test-app.js');
    app = await helpers.createTestApp();
    await helpers.resetDatabase(app);
  });
  afterAll(async () => {
    await app.close();
    Object.assign(process.env, saved);
  });

  it('limits sign-in per IP, and only sign-in', async () => {
    const u = await helpers.registerUser(app);
    const login = () =>
      http()
        .post('/auth/login')
        .send({ email: u.email, password: 'wrong password!' });
    for (let i = 0; i < 3; i++) await login().expect(401);
    const limited = await login().expect(429);
    expect(limited.body.error.code).toBe('rate_limited');

    // Refresh and routes without the tag keep working.
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: u.refreshToken })
      .expect(200);
    await http().get('/users/me').set(helpers.auth(u)).expect(200);
  });

  it('limits invitations per member, not per IP', async () => {
    const [alice, bob] = [
      await helpers.registerUser(app),
      await helpers.registerUser(app),
    ];
    const invite = (from: typeof alice, to: typeof alice) =>
      http()
        .post('/invitations')
        .set(helpers.auth(from))
        .send({ inviteeId: to.id });
    await invite(alice, bob).expect(201);
    await invite(alice, bob).expect(409); // refused, but it still counts
    const limited = await invite(alice, bob).expect(429);
    expect(limited.body.error.code).toBe('rate_limited');
    await invite(bob, alice).expect(201);
  });
});
