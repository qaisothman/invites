import request from 'supertest';
import { DataSource } from 'typeorm';
import { NotificationsService } from '../src/notifications/notifications.service';
import {
  auth,
  createTestApp,
  registerUser,
  resetDatabase,
  TestApp,
  TestUser,
} from './test-app';

describe('Invitations (e2e)', () => {
  let app: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  const http = () => request(app.getHttpServer());
  const db = () => app.get(DataSource);

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(app);
    alice = await registerUser(app, { displayName: 'Alice' });
    bob = await registerUser(app, { displayName: 'Bob' });
  });
  afterAll(() => app.close());

  const invite = (from: TestUser, to: TestUser, message?: string) =>
    http()
      .post('/invitations')
      .set(auth(from))
      .send({ inviteeId: to.id, message });

  it('creates the invitation and its notification in one transaction', async () => {
    const res = await invite(alice, bob, 'Coffee on Friday?').expect(201);
    expect(res.body).toMatchObject({
      status: 'pending',
      message: 'Coffee on Friday?',
      inviter: { id: alice.id, displayName: 'Alice' },
      invitee: { id: bob.id, displayName: 'Bob' },
    });
    const [n] = (await db().query(`SELECT * FROM notifications`)) as Record<
      string,
      unknown
    >[];
    expect(n).toMatchObject({
      user_id: bob.id,
      type: 'invitation.received',
      title: 'Alice invited you',
      body: 'Tap to see the invitation', // the message stays in the app
      status: 'pending',
      dedupe_key: `invitation:${res.body.id}:received`,
    });

    // Neither without the other: if the notification can't be written, the
    // invitation isn't either.
    const carol = await registerUser(app);
    const spy = jest
      .spyOn(app.get(NotificationsService), 'enqueue')
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    try {
      await invite(alice, carol).expect(500);
    } finally {
      spy.mockRestore();
    }
    const [{ i, k }] = (await db().query(
      `SELECT (SELECT count(*) FROM invitations WHERE invitee_id = $1)::int AS i,
              (SELECT count(*) FROM notifications WHERE user_id = $1)::int AS k`,
      [carol.id],
    )) as { i: number; k: number }[];
    expect([i, k]).toEqual([0, 0]);
  });

  it('refuses self-invites, unknown members and a second open invitation', async () => {
    expect((await invite(alice, alice).expect(400)).body.error.code).toBe(
      'cannot_invite_self',
    );
    const ghost = { ...bob, id: '00000000-0000-4000-8000-000000000000' };
    expect((await invite(alice, ghost).expect(404)).body.error.code).toBe(
      'user_not_found',
    );
    await invite(alice, bob).expect(201);
    expect((await invite(alice, bob).expect(409)).body.error.code).toBe(
      'invitation_already_pending',
    );
    // The refused one wrote nothing: still exactly one invitation and one
    // notification.
    const [{ i, n }] = (await db().query(
      `SELECT (SELECT count(*) FROM invitations)::int AS i, (SELECT count(*) FROM notifications)::int AS n`,
    )) as { i: number; n: number }[];
    expect([i, n]).toEqual([1, 1]);
  });

  it('shows an invitation only to the two people involved', async () => {
    const carol = await registerUser(app);
    const { body } = await invite(alice, bob).expect(201);
    await http().get(`/invitations/${body.id}`).set(auth(carol)).expect(404);
    await http().get(`/invitations/${body.id}`).set(auth(alice)).expect(200);
  });

  it('lets only the invitee answer and the inviter cancel', async () => {
    const carol = await registerUser(app);
    const { body } = await invite(alice, bob).expect(201);
    for (const action of ['accept', 'decline', 'cancel'])
      await http()
        .post(`/invitations/${body.id}/${action}`)
        .set(auth(carol))
        .expect(404);
    await http()
      .post(`/invitations/${body.id}/accept`)
      .set(auth(alice))
      .expect(404);
    await http()
      .post(`/invitations/${body.id}/cancel`)
      .set(auth(bob))
      .expect(404);
    const { status } = await db()
      .query(`SELECT status FROM invitations WHERE id = $1`, [body.id])
      .then((r: { status: string }[]) => r[0]);
    expect(status).toBe('pending');
    await http()
      .post(`/invitations/${body.id}/accept`)
      .set(auth(bob))
      .expect(200);
  });

  it('records when the invitee first opens it, and counts the push as seen', async () => {
    const { body } = await invite(alice, bob).expect(201);
    const opened = await http()
      .get(`/invitations/${body.id}`)
      .set(auth(bob))
      .expect(200);
    expect(opened.body.openedAt).toEqual(expect.any(String));
    const again = await http()
      .get(`/invitations/${body.id}`)
      .set(auth(bob))
      .expect(200);
    expect(again.body.openedAt).toBe(opened.body.openedAt);
    const [n] = (await db().query(
      `SELECT status, opened_at, delivered_at FROM notifications`,
    )) as {
      status: string;
      opened_at: Date | null;
      delivered_at: Date | null;
    }[];
    expect(n.status).toBe('opened');
    expect(n.opened_at).toBeInstanceOf(Date);
    expect(n.delivered_at).toBeNull(); // only a phone confirms delivery
  });

  it('accepts idempotently and tells the inviter', async () => {
    const { body } = await invite(alice, bob).expect(201);
    const first = await http()
      .post(`/invitations/${body.id}/accept`)
      .set(auth(bob))
      .expect(200);
    expect(first.body.status).toBe('accepted');
    // A retry after a timeout gets the same answer, not an error.
    const again = await http()
      .post(`/invitations/${body.id}/accept`)
      .set(auth(bob))
      .expect(200);
    expect(again.body.respondedAt).toBe(first.body.respondedAt);
    // Changing your mind afterwards is a conflict.
    const late = await http()
      .post(`/invitations/${body.id}/decline`)
      .set(auth(bob))
      .expect(409);
    expect(late.body.error.code).toBe('invitation_already_responded');
    // Only the invitee can answer.
    await http()
      .post(`/invitations/${body.id}/accept`)
      .set(auth(alice))
      .expect(404);

    const toAlice = (await db().query(
      `SELECT title FROM notifications WHERE user_id = $1`,
      [alice.id],
    )) as { title: string }[];
    expect(toAlice).toEqual([{ title: 'Bob accepted your invitation' }]);
  });

  it('lets only one of two simultaneous answers win', async () => {
    const { body } = await invite(alice, bob).expect(201);
    const [a, b] = await Promise.all([
      http().post(`/invitations/${body.id}/accept`).set(auth(bob)),
      http().post(`/invitations/${body.id}/decline`).set(auth(bob)),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('refuses expired and cancelled invitations with 410', async () => {
    const first = await invite(alice, bob).expect(201);
    await db().query(
      `UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [first.body.id],
    );
    const expired = await http()
      .post(`/invitations/${first.body.id}/accept`)
      .set(auth(bob))
      .expect(410);
    expect(expired.body.error.code).toBe('invitation_expired');
    // Expired before the sweeper got to it: it no longer blocks a new one.
    await invite(alice, bob).expect(201);

    const carol = await registerUser(app);
    const second = await invite(carol, bob).expect(201);
    await http()
      .post(`/invitations/${second.body.id}/cancel`)
      .set(auth(carol))
      .expect(200);
    const cancelled = await http()
      .post(`/invitations/${second.body.id}/accept`)
      .set(auth(bob))
      .expect(410);
    expect(cancelled.body.error.code).toBe('invitation_cancelled');
  });

  it('pages through the inbox with a cursor, even past rows that share a timestamp', async () => {
    const senders = [alice, await registerUser(app), await registerUser(app)];
    for (const s of senders) await invite(s, bob).expect(201);
    // The same instant, below a millisecond, on every row.
    await db().query(
      `UPDATE invitations SET created_at = date_trunc('second', now()) + interval '500 microseconds'`,
    );

    const page1 = await http()
      .get('/invitations?box=received&limit=2')
      .set(auth(bob))
      .expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await http()
      .get(`/invitations?box=received&limit=2&cursor=${page1.body.nextCursor}`)
      .set(auth(bob))
      .expect(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
    const ids = [...page1.body.items, ...page2.body.items].map(
      (i: { id: string }) => i.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('rejects a cursor it did not issue', async () => {
    const enc = (s: string) => Buffer.from(s).toString('base64url');
    for (const path of ['/invitations', '/notifications']) {
      for (const cursor of [
        'garbage',
        enc('2026-01-01T00:00:00.000Z|x'),
        enc('2026-01-01|00000000-0000-4000-8000-000000000000'),
      ]) {
        const res = await http()
          .get(`${path}?cursor=${cursor}`)
          .set(auth(bob))
          .expect(400);
        expect(res.body.error.code).toBe('invalid_cursor');
      }
    }
  });
});
