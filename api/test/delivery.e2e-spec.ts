import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { MetricsService } from '../src/metrics/metrics.service';
import { OutboxDispatcher } from '../src/notifications/dispatcher';
import { FakePushSender } from '../src/notifications/providers/fake-push.sender';
import { NOT_SENT } from '../src/notifications/providers/push-sender';
import type {
  PushMessage,
  PushResult,
} from '../src/notifications/providers/push-sender';
import {
  addDevice,
  auth,
  createTestApp,
  registerUser,
  resetDatabase,
  TestApp,
  TestUser,
} from './test-app';

interface Row {
  id: string;
  status: string;
  attempts: number;
  transport_failures: number;
  next_attempt_at: Date;
  last_error: string | null;
  sent_at: Date | null;
}

// The notification pipeline end to end: outbox -> dispatcher -> Expo (fake)
// -> receipts, plus the failure modes each part exists for.
describe('Notification delivery (e2e)', () => {
  let app: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  let push: FakePushSender;
  const http = () => request(app.getHttpServer());
  const db = () => app.get(DataSource);
  const dispatch = () => app.get(OutboxDispatcher).runOnce();
  // How many times a metric has counted an outcome since the app started.
  const counted = async (metric: 'dispatched', outcome: string) =>
    (await app.get(MetricsService)[metric].get()).values.find(
      (v) => v.labels.outcome === outcome,
    )?.value ?? 0;
  const notif = async () =>
    (
      (await db().query(`SELECT * FROM notifications WHERE user_id = $1`, [
        bob.id,
      ])) as Row[]
    )[0];

  beforeAll(async () => {
    app = await createTestApp();
    push = app.get(FakePushSender);
  });
  beforeEach(async () => {
    await resetDatabase(app);
    alice = await registerUser(app, { displayName: 'Alice' });
    bob = await registerUser(app, { displayName: 'Bob' });
  });
  afterAll(() => app.close());

  const invite = () =>
    http()
      .post('/invitations')
      .set(auth(alice))
      .send({ inviteeId: bob.id })
      .expect(201);

  // Runs `during` while the dispatcher's push is in flight, then answers
  // with `answer` (the fake's own results when left out).
  const duringSend = (
    during: (messages: PushMessage[]) => Promise<unknown>,
    answer?: PushResult[],
  ) => {
    const real = push.send.bind(push);
    return jest
      .spyOn(push, 'send')
      .mockImplementation(async (messages: PushMessage[]) => {
        const results = answer ?? (await real(messages));
        await during(messages);
        return results;
      });
  };

  it('sends to every active device and records a ticket per device', async () => {
    const phone = await addDevice(app, bob);
    const tablet = await addDevice(app, bob);
    await invite();
    expect(await dispatch()).toBe(1);

    const n = await notif();
    expect(n.status).toBe('sent');
    expect(push.sent.map((m) => m.to).sort()).toEqual([phone, tablet].sort());
    expect(push.sent[0].data).toMatchObject({
      notificationId: n.id,
      type: 'invitation.received',
    });
    const tickets = (await db().query(
      `SELECT status, receipt_status FROM push_tickets`,
    )) as { status: string; receipt_status: string }[];
    expect(tickets).toEqual([
      { status: 'ok', receipt_status: 'pending' },
      { status: 'ok', receipt_status: 'pending' },
    ]);
  });

  it('retries a provider outage with backoff, then succeeds', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'flaky');
    await invite();
    await dispatch();
    let n = await notif();
    expect(n).toMatchObject({ status: 'pending', attempts: 1 });
    expect(new Date(n.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect(n.last_error).toMatch(/simulated outage/);

    // Not due yet: the dispatcher leaves it alone.
    expect(await dispatch()).toBe(0);

    push.setBehaviour(token, 'ok');
    await db().query(`UPDATE notifications SET next_attempt_at = now()`);
    await dispatch();
    n = await notif();
    expect(n).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
  });

  it('keeps retrying while push credentials are missing, then delivers once fixed', async () => {
    // A phone with a push token, but no APNs key on EAS: the fault is our
    // setup, not the message, so the notification stays queued and retries.
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'no_credentials');
    await invite();
    await dispatch();
    let n = await notif();
    expect(n).toMatchObject({ status: 'pending', attempts: 1 });
    expect(n.last_error).toMatch(/InvalidCredentials/);

    push.setBehaviour(token, 'ok'); // the key is uploaded
    await db().query(`UPDATE notifications SET next_attempt_at = now()`);
    await dispatch();
    n = await notif();
    expect(n).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
  });

  it('keeps retrying credential errors past the attempt limit, for 24 hours', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'no_credentials');
    await invite();
    // One transport attempt left (PUSH_MAX_ATTEMPTS is 8): a credential
    // error doesn't use it.
    await db().query(`UPDATE notifications SET transport_failures = 7`);
    await dispatch();
    expect(await notif()).toMatchObject({
      status: 'pending',
      transport_failures: 7,
    });

    // PUSH_GIVE_UP_AFTER_HOURS is 24.
    await db().query(
      `UPDATE notifications SET created_at = now() - interval '25 hours', next_attempt_at = now()`,
    );
    await dispatch();
    expect((await notif()).status).toBe('failed');
  });

  it('keeps all 8 transport attempts after many provider-side retries', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'no_credentials');
    await invite();
    const again = () =>
      db().query(`UPDATE notifications SET next_attempt_at = now()`);
    for (let i = 0; i < 10; i++) {
      await dispatch();
      await again();
    }
    expect(await notif()).toMatchObject({
      status: 'pending',
      attempts: 10,
      transport_failures: 0,
    });

    // Then an outage: the first transport error is retried...
    push.setBehaviour(token, 'flaky');
    await dispatch();
    expect(await notif()).toMatchObject({
      status: 'pending',
      transport_failures: 1,
    });
    // ...and the eighth gives up (PUSH_MAX_ATTEMPTS is 8).
    for (let i = 2; i <= 8; i++) {
      expect((await notif()).status).toBe('pending');
      await again();
      await dispatch();
    }
    expect(await notif()).toMatchObject({
      status: 'failed',
      attempts: 18,
      transport_failures: 8,
    });
  });

  it('stops sending at a deadline inside the lease, and queues what was left without using up an attempt', async () => {
    await addDevice(app, bob);
    await invite();
    let lease = new Date(0);
    const spy = duringSend(async () => {
      [{ locked_until: lease }] = (await db().query(
        `SELECT locked_until FROM notifications`,
      )) as { locked_until: Date }[];
    }, [{ ok: false, error: NOT_SENT, message: 'x', retryable: true }]);
    let deadline = 0;
    try {
      await dispatch();
      // The fake's own send takes no deadline; the dispatcher passes one.
      [, deadline] = spy.mock.calls[0] as unknown as [unknown, number];
    } finally {
      spy.mockRestore();
    }
    // At least 15 s of the lease are left after the deadline for the writes.
    expect(lease.getTime() - deadline).toBeGreaterThanOrEqual(15_000);

    const n = await notif();
    expect(n).toMatchObject({
      status: 'pending',
      attempts: 1,
      transport_failures: 0,
    });
    expect(new Date(n.next_attempt_at).getTime()).toBeLessThan(
      Date.now() + 10_000,
    );
    // Nothing reached Expo, so there is no ticket.
    expect(await db().query(`SELECT id FROM push_tickets`)).toHaveLength(0);
  });

  it('does not push again an invitation seen while its push failed', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'flaky');
    const { body } = await invite();
    const spy = duringSend(() =>
      http().get(`/invitations/${body.id}`).set(auth(bob)).expect(200),
    );
    try {
      await dispatch();
    } finally {
      spy.mockRestore();
    }
    expect((await notif()).status).toBe('opened');

    push.setBehaviour(token, 'ok');
    await db().query(`UPDATE notifications SET next_attempt_at = now()`);
    expect(await dispatch()).toBe(0);
    expect(push.sent).toHaveLength(0);
  });

  it('ignores a late result from a worker whose claim was taken over', async () => {
    await addDevice(app, bob);
    await invite();
    // While this worker waits on Expo, its lease runs out and another
    // worker claims the row again.
    const spy = duringSend(
      () => db().query(`UPDATE notifications SET attempts = attempts + 1`),
      [{ ok: false, error: 'MessageTooBig', message: 'x', retryable: false }],
    );
    const failedBefore = await counted('dispatched', 'failed');
    try {
      await dispatch();
    } finally {
      spy.mockRestore();
    }
    expect(await notif()).toMatchObject({ status: 'sending', attempts: 2 });
    // Nor counts an outcome it didn't record.
    expect(await counted('dispatched', 'failed')).toBe(failedBefore);
  });

  it('treats an Android phone silent for 90 days as unreachable', async () => {
    await addDevice(app, bob, undefined, { platform: 'android' });
    await db().query(
      `UPDATE devices SET last_seen_at = now() - interval '91 days'`,
    );
    await invite();
    await dispatch();
    expect(push.sent).toHaveLength(0); // Android has hibernated the app
    expect((await notif()).status).toBe('unreachable');

    // An iPhone that quiet still gets the push: iOS doesn't hibernate apps.
    await db().query(`UPDATE devices SET platform = 'ios'`);
    await db().query(
      `UPDATE notifications SET status = 'pending', next_attempt_at = now()`,
    );
    await dispatch();
    expect(push.sent).toHaveLength(1);
  });

  it('sends each notification exactly once with four workers racing', async () => {
    const invitees: TestUser[] = [];
    for (let i = 0; i < 40; i++) {
      const u = await registerUser(app);
      await addDevice(app, u);
      invitees.push(u);
    }
    for (const u of invitees) {
      await http()
        .post('/invitations')
        .set(auth(alice))
        .send({ inviteeId: u.id })
        .expect(201);
    }
    const dispatcher = app.get(OutboxDispatcher);
    const config = app.get(ConfigService);
    const real = config.get.bind(config) as (k: string, o?: unknown) => unknown;
    const batch = jest
      .spyOn(config, 'get')
      .mockImplementation((k: string, o?: unknown) =>
        k === 'DISPATCH_BATCH_SIZE' ? 3 : real(k, o),
      );
    const sends = jest.spyOn(push, 'send');
    try {
      // Four concurrent workers, three rows per claim, so they interleave
      // over many rounds.
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while ((await dispatcher.runOnce()) > 0) {
            /* drain */
          }
        }),
      );
      // 40 rows, at most 3 per claim: at least 14 claims did the work.
      expect(sends.mock.calls.length).toBeGreaterThanOrEqual(14);
    } finally {
      batch.mockRestore();
      sends.mockRestore();
    }
    const ids = push.sent.map((m) => m.data.notificationId);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it('puts work from a crashed worker back in the queue', async () => {
    await addDevice(app, bob);
    await invite();
    // A worker claimed it and died: 'sending' with an expired lease.
    await db().query(
      `UPDATE notifications SET status = 'sending', locked_until = now() - interval '1 second'`,
    );
    expect(await dispatch()).toBe(0);
    expect(await app.get(OutboxDispatcher).reclaimStale()).toBe(1);
    expect(await dispatch()).toBe(1);
    expect((await notif()).status).toBe('sent');
  });
});
