import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/auth/auth.service';
import {
  auth,
  createTestApp,
  registerUser,
  resetDatabase,
  TestApp,
} from './test-app';

describe('Auth (e2e)', () => {
  let app: TestApp;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(() => resetDatabase(app));
  afterAll(() => app.close());

  it('registers, then reads the profile with the access token', async () => {
    const u = await registerUser(app, { displayName: 'Ada' });
    const me = await http().get('/users/me').set(auth(u)).expect(200);
    expect(me.body).toMatchObject({
      id: u.id,
      displayName: 'Ada',
      invitationEmails: true,
      role: 'member',
    });
    expect(me.body).not.toHaveProperty('passwordHash');
    expect(me.body).not.toHaveProperty('lastInvitationEmailAt');
  });

  it('refuses display names with an http(s) or www link, a control character or a line separator', async () => {
    for (const displayName of [
      'Your account is locked, visit https://evil.example',
      'www.evil.example',
      'Ada\r\nBcc: everyone@example.com',
      'Ada https://evil.example',
      'Ada Lovelace',
    ]) {
      await http()
        .post('/auth/register')
        .send({
          email: 'x@example.com',
          password: 'a long password',
          displayName,
        })
        .expect(400);
    }
  });

  it('refuses null for a profile field', async () => {
    const u = await registerUser(app);
    for (const body of [{ displayName: null }, { invitationEmails: null }]) {
      const res = await http()
        .patch('/users/me')
        .set(auth(u))
        .send(body)
        .expect(400);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });

  it('rejects a second account with the same email, in any case', async () => {
    await registerUser(app, { email: 'same@example.com' });
    const res = await http()
      .post('/auth/register')
      .send({
        email: 'SAME@example.com',
        password: 'another long one',
        displayName: 'X',
      })
      .expect(409);
    expect(res.body.error.code).toBe('email_taken');
  });

  it('validates input and rejects unknown fields', async () => {
    const res = await http()
      .post('/auth/register')
      .send({
        email: 'x@example.com',
        password: 'short',
        displayName: 'X',
        isAdmin: true,
      })
      .expect(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.join(' ')).toMatch(
      /isAdmin should not exist/,
    );
    expect(res.body.error.details.join(' ')).toMatch(/password/);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const u = await registerUser(app);
    const wrong = await http()
      .post('/auth/login')
      .send({ email: u.email, password: 'wrong password!' })
      .expect(401);
    const unknown = await http()
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong password!' })
      .expect(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
  });

  it('answers 401 without a token, and to a token that is not a JWT', async () => {
    const res = await http().get('/users/me').expect(401);
    expect(res.body.error.code).toBe('missing_token');
    const bad = await http()
      .get('/users/me')
      .set('authorization', 'Bearer not-a-jwt')
      .expect(401);
    expect(bad.body.error.code).toBe('invalid_token');
  });

  const refresh = (refreshToken: string) =>
    http().post('/auth/refresh').send({ refreshToken });

  it('rotates refresh tokens and revokes the family when one is reused', async () => {
    const u = await registerUser(app);
    const first = await refresh(u.refreshToken).expect(200);
    const rotated = first.body.refreshToken as string;
    expect(rotated).not.toBe(u.refreshToken);
    const second = await refresh(rotated).expect(200);

    // The first token comes back after its successor was used: someone
    // copied it. Everything is revoked, including the newest token.
    const reuse = await refresh(u.refreshToken).expect(401);
    expect(reuse.body.error.code).toBe('refresh_token_reused');
    await refresh(second.body.refreshToken as string).expect(401);
  });

  it('accepts the previous token again if the rotation response was lost', async () => {
    const u = await registerUser(app);
    // The server rotates, but the phone never sees the response.
    const lost = (await refresh(u.refreshToken).expect(200)).body
      .refreshToken as string;

    // The phone retries with the token it has and gets a fresh one; the
    // lost successor is replaced, so only one token is live.
    const retried = await refresh(u.refreshToken).expect(200);
    const current = retried.body.refreshToken as string;
    expect(current).not.toBe(lost);
    await http()
      .get('/users/me')
      .set('authorization', `Bearer ${retried.body.accessToken as string}`)
      .expect(200);
    const live = await app
      .get(DataSource)
      .query(
        'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [u.id],
      );
    expect(live[0].n).toBe(1);

    // Once the new token is used, the old one is a copy again.
    await refresh(current).expect(200);
    const reuse = await refresh(u.refreshToken).expect(401);
    expect(reuse.body.error.code).toBe('refresh_token_reused');
  });

  it('treats the previous token as reuse once the grace window has passed', async () => {
    const u = await registerUser(app);
    const next = (await refresh(u.refreshToken).expect(200)).body
      .refreshToken as string;
    // Pretend the rotation happened a minute ago.
    await app
      .get(DataSource)
      .query(
        "UPDATE sessions SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL AND user_id = $1",
        [u.id],
      );
    const reuse = await refresh(u.refreshToken).expect(401);
    expect(reuse.body.error.code).toBe('refresh_token_reused');
    await refresh(next).expect(401);
  });

  it('leaves one live token when five refreshes race with the same token', async () => {
    const u = await registerUser(app);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => refresh(u.refreshToken)),
    );
    // Every racer is answered (the losers through the grace rule), and the
    // family still ends with exactly one live token.
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const live = await app
      .get(DataSource)
      .query(
        'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [u.id],
      );
    expect(live[0].n).toBe(1);
  });

  it('leaves no live token when a family is revoked with a refresh in flight', async () => {
    const live = (userId: string) =>
      app
        .get(DataSource)
        .query(
          'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
          [userId],
        )
        .then((r: { n: number }[]) => r[0].n);
    for (let i = 0; i < 10; i++) {
      // Reuse detection: the stale token comes back while the current one
      // is being refreshed.
      const u = await registerUser(app);
      const current = (await refresh(u.refreshToken).expect(200)).body
        .refreshToken as string;
      await app
        .get(DataSource)
        .query(
          "UPDATE sessions SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL AND user_id = $1",
          [u.id],
        );
      await Promise.all([refresh(current), refresh(u.refreshToken)]);
      expect(await live(u.id)).toBe(0);

      // Sign-out racing a refresh.
      const v = await registerUser(app);
      await Promise.all([
        refresh(v.refreshToken),
        http().post('/auth/logout').send({ refreshToken: v.refreshToken }),
      ]);
      expect(await live(v.id)).toBe(0);
    }
  });

  it('deletes sessions past their expiry, and only those', async () => {
    const u = await registerUser(app);
    await refresh(u.refreshToken).expect(200);
    await app
      .get(DataSource)
      .query(
        `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE revoked_at IS NOT NULL`,
      );
    expect(await app.get(AuthService).pruneExpiredSessions()).toBe(1);
    const [{ n }] = (await app
      .get(DataSource)
      .query('SELECT count(*)::int AS n FROM sessions')) as { n: number }[];
    expect(n).toBe(1);
  });

  it('logs out by revoking the refresh token', async () => {
    const u = await registerUser(app);
    await http()
      .post('/auth/logout')
      .send({ refreshToken: u.refreshToken })
      .expect(204);
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: u.refreshToken })
      .expect(401);
  });

  it('keeps admin routes for admins', async () => {
    const u = await registerUser(app);
    const res = await http()
      .get('/admin/funnel/invitations?from=2026-01-01&to=2027-01-01')
      .set(auth(u))
      .expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});
