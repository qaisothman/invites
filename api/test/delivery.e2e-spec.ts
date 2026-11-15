import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import { MetricsService } from '../src/metrics/metrics.service';
import { OutboxDispatcher } from '../src/notifications/dispatcher';
import { InvitationEmailer } from '../src/notifications/invitation-emails';
import { FakeEmailSender } from '../src/notifications/providers/email-sender';
import { FakePushSender } from '../src/notifications/providers/fake-push.sender';
import { NOT_SENT } from '../src/notifications/providers/push-sender';
import type {
  PushMessage,
  PushResult,
} from '../src/notifications/providers/push-sender';
import { ReceiptPoller } from '../src/notifications/receipts';
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
  email_status: string;
  next_attempt_at: Date;
  last_error: string | null;
  sent_at: Date | null;
}

// The notification pipeline end to end: outbox -> dispatcher -> Expo (fake)
// -> receipts -> the invitation email for invitees push can't reach, plus the
// failure modes each part exists for.
describe('Notification delivery (e2e)', () => {
  let app: TestApp;
  let alice: TestUser;
  let bob: TestUser;
  let push: FakePushSender;
  let mail: FakeEmailSender;
  const http = () => request(app.getHttpServer());
  const db = () => app.get(DataSource);
  const dispatch = () => app.get(OutboxDispatcher).runOnce();
  const receipts = () => app.get(ReceiptPoller).runOnce();
  const emails = () => app.get(InvitationEmailer).runOnce();
  // How many times a metric has counted an outcome since the app started.
  const counted = async (
    metric: 'dispatched' | 'invitationEmails',
    outcome: string,
  ) =>
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
    mail = app.get(FakeEmailSender);
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
  const ack = (m: PushMessage) =>
    http()
      .post(`/notifications/${m.data.notificationId as string}/ack`)
      .send({ token: m.data.ackToken })
      .expect(204);

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

    await receipts();
    const after = (await db().query(
      `SELECT receipt_status FROM push_tickets`,
    )) as { receipt_status: string }[];
    expect(after.every((t) => t.receipt_status === 'ok')).toBe(true);
  });

  it('follows the push to the phone: delivered, then opened', async () => {
    await addDevice(app, bob);
    await invite();
    await dispatch();
    const { id } = await notif();
    await http()
      .post(`/notifications/${id}/delivered`)
      .set(auth(bob))
      .expect(204);
    expect((await notif()).status).toBe('delivered');
    await http().post(`/notifications/${id}/opened`).set(auth(bob)).expect(204);
    await http()
      .post(`/notifications/${id}/delivered`)
      .set(auth(bob))
      .expect(204); // late, out of order
    expect((await notif()).status).toBe('opened'); // never moves backwards
    // Someone else's notification is invisible.
    await http()
      .post(`/notifications/${id}/opened`)
      .set(auth(alice))
      .expect(404);
  });

  it('lets a background task confirm delivery with the token from the push', async () => {
    await addDevice(app, bob);
    await invite();
    await dispatch();
    const { id } = await notif();
    const token = push.sent[0].data.ackToken as string;
    expect(token).toBeTruthy();

    // No Authorization header: the signed token is the proof.
    const wrong = await http()
      .post(`/notifications/${id}/ack`)
      .send({ token: token.slice(0, -2) + 'xx' })
      .expect(401);
    expect(wrong.body.error.code).toBe('invalid_ack_token');
    await http().post(`/notifications/${id}/ack`).send({ token }).expect(204);
    expect((await notif()).status).toBe('delivered');
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

  it('keeps a confirmation that arrives while the push is being sent', async () => {
    await addDevice(app, bob);
    await invite();
    const spy = duringSend((messages) => Promise.all(messages.map(ack)));
    try {
      await dispatch();
    } finally {
      spy.mockRestore();
    }
    const n = await notif();
    expect(n.status).toBe('delivered');
    expect(n.sent_at).toBeInstanceOf(Date);
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

  it('does not push an invitation withdrawn while it waited', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'flaky');
    const { body } = await invite();
    await dispatch();
    expect((await notif()).status).toBe('pending');

    await http()
      .post(`/invitations/${body.id}/cancel`)
      .set(auth(alice))
      .expect(200);
    push.setBehaviour(token, 'ok');
    await db().query(`UPDATE notifications SET next_attempt_at = now()`);
    await dispatch();
    expect(push.sent).toHaveLength(0);
    // Nothing was sent and nothing failed.
    expect((await notif()).status).toBe('withdrawn');
    await emails();
    expect(mail.sent).toHaveLength(0);
  });

  it('gives up after the last attempt, and emails the invitee instead', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'flaky');
    await invite();
    await db().query(`UPDATE notifications SET transport_failures = 7`); // PUSH_MAX_ATTEMPTS is 8
    await dispatch();
    expect((await notif()).status).toBe('failed');

    await emails();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      to: bob.email,
      subject: 'Alice invited you',
    });
    expect(mail.sent[0].text).toMatch(/Open the invitation: .*\/i\//);
    expect((await notif()).email_status).toBe('sent');
  });

  it('disables uninstalled devices and emails the person, once', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'dead');
    await invite();
    await dispatch();
    expect((await notif()).status).toBe('unreachable');
    const [d] = (await db().query(`SELECT disabled_reason FROM devices`)) as {
      disabled_reason: string;
    }[];
    expect(d.disabled_reason).toBe('DeviceNotRegistered');

    await emails();
    await emails(); // a second run must not email again
    expect(mail.sent).toHaveLength(1);
  });

  it('finds dead tokens from receipts when the send looked fine', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'receipt_error');
    await invite();
    await dispatch();
    expect((await notif()).status).toBe('sent');
    await receipts();
    expect((await notif()).status).toBe('failed');
    const [d] = (await db().query(`SELECT disabled_at FROM devices`)) as {
      disabled_at: Date | null;
    }[];
    expect(d.disabled_at).not.toBeNull();
  });

  it('keeps a phone enabled that registered again before its receipt came', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'receipt_error');
    await invite();
    await dispatch();
    // Reinstalled within the 15 minutes before the receipt: same token.
    await db().query(
      `UPDATE push_tickets SET created_at = now() - interval '15 minutes'`,
    );
    await addDevice(app, bob, token);
    await receipts();
    const [d] = (await db().query(`SELECT disabled_at FROM devices`)) as {
      disabled_at: Date | null;
    }[];
    expect(d.disabled_at).toBeNull();
  });

  it('re-queues a push that Apple or Google rate-limited', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'receipt_rate_limited');
    await invite();
    await dispatch();
    await receipts();
    const n = await notif();
    expect(n).toMatchObject({
      status: 'pending',
      last_error: 'receipt: MessageRateExceeded',
    });
    expect(new Date(n.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    const [d] = (await db().query(`SELECT disabled_at FROM devices`)) as {
      disabled_at: Date | null;
    }[];
    expect(d.disabled_at).toBeNull(); // the token is fine; only the rate was too high

    push.setBehaviour(token, 'ok');
    await db().query(`UPDATE notifications SET next_attempt_at = now()`);
    await dispatch();
    expect((await notif()).status).toBe('sent');
  });

  it('re-queues rate-limited receipts past the attempt limit, for 24 hours', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'receipt_rate_limited');
    await invite();
    await dispatch();
    // The send that got through was the last of its transport attempts.
    await db().query(`UPDATE notifications SET transport_failures = 7`);
    await receipts();
    expect((await notif()).status).toBe('pending');

    await db().query(
      `UPDATE notifications SET created_at = now() - interval '25 hours', next_attempt_at = now()`,
    );
    await dispatch();
    await receipts();
    expect((await notif()).status).toBe('failed');
  });

  it('keeps every transport attempt after rate-limited receipts', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'receipt_rate_limited');
    await invite();
    for (let i = 0; i < 9; i++) {
      await dispatch();
      await receipts();
      await db().query(`UPDATE notifications SET next_attempt_at = now()`);
    }
    expect(await notif()).toMatchObject({
      status: 'pending',
      attempts: 9,
      transport_failures: 0,
    });
    push.setBehaviour(token, 'flaky');
    await dispatch();
    expect(await notif()).toMatchObject({
      status: 'pending',
      transport_failures: 1,
    });
  });

  it('fails a push whose latest receipt is final, after an earlier one was rate-limited', async () => {
    const token = await addDevice(app, bob);
    push.setBehaviour(token, 'receipt_rate_limited');
    await invite();
    await dispatch();
    await receipts();
    expect((await notif()).status).toBe('pending');

    // The resend's receipt is final: the first send's rate limit no longer
    // counts.
    push.setBehaviour(token, 'receipt_error');
    await db().query(`UPDATE notifications SET next_attempt_at = now()`);
    await dispatch();
    await receipts();
    expect(await notif()).toMatchObject({
      status: 'failed',
      last_error: 'all receipts rejected',
    });
  });

  it('does not email someone whose phone can show the push', async () => {
    await addDevice(app, bob);
    await invite();
    await dispatch();
    // Sent but never confirmed: a phone that can show it got it, so push is
    // the channel. One channel per notification, not both.
    await emails();
    expect(mail.sent).toHaveLength(0);
    expect((await notif()).email_status).toBe('none');
  });

  it('pushes only to phones that can show it, and emails when none can', async () => {
    const allowed = await addDevice(app, bob);
    await addDevice(app, bob, undefined, { notifications: 'off' });
    await invite();
    await dispatch();
    expect(push.sent.map((m) => m.to)).toEqual([allowed]);

    // Notifications turned off on the last phone: nothing is pushed at all.
    await resetDatabase(app);
    alice = await registerUser(app, { displayName: 'Alice' });
    bob = await registerUser(app, { displayName: 'Bob' });
    await addDevice(app, bob, undefined, { notifications: 'off' });
    await addDevice(app, bob, undefined, { notifications: 'not_asked' });
    await invite();
    await dispatch();
    expect(push.sent).toHaveLength(0);
    expect((await notif()).status).toBe('unreachable');
    await emails();
    expect(mail.sent).toHaveLength(1);
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

  it('waits 15 minutes before emailing, and skips an invitation already seen', async () => {
    // Tests run with EMAIL_AFTER_SECONDS=0; this one uses the real 15 minutes.
    const config = app.get(ConfigService);
    const real = config.get.bind(config) as (k: string, o?: unknown) => unknown;
    const spy = jest
      .spyOn(config, 'get')
      .mockImplementation((k: string, o?: unknown) =>
        k === 'EMAIL_AFTER_SECONDS' ? 900 : real(k, o),
      );
    try {
      const carol = await registerUser(app, { displayName: 'Carol' });
      const { body } = await invite();
      await http()
        .post('/invitations')
        .set(auth(carol))
        .send({ inviteeId: bob.id })
        .expect(201);
      await dispatch();
      await dispatch();
      const age = (i: string) =>
        db().query(
          `UPDATE notifications SET created_at = now() - interval '${i}'`,
        );

      await age('14 minutes');
      await emails();
      expect(mail.sent).toHaveLength(0); // not yet

      // Bob opens Alice's invitation in the app; Carol's he hasn't seen.
      await http().get(`/invitations/${body.id}`).set(auth(bob)).expect(200);
      await age('16 minutes');
      await emails();
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0].subject).toBe('Carol invited you');
    } finally {
      spy.mockRestore();
    }
  });

  it('puts everything waiting in one email, and sends at most one a day', async () => {
    const carol = await registerUser(app, { displayName: 'Carol' });
    await invite();
    await http()
      .post('/invitations')
      .set(auth(carol))
      .send({ inviteeId: bob.id })
      .expect(201);
    await dispatch();
    await emails();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe('You have 2 new invitations');
    expect(mail.sent[0].text).toMatch(/Alice invited you/);
    expect(mail.sent[0].text).toMatch(/Carol invited you/);

    // A third invitation the same day waits for tomorrow's email.
    const dave = await registerUser(app, { displayName: 'Dave' });
    await http()
      .post('/invitations')
      .set(auth(dave))
      .send({ inviteeId: bob.id })
      .expect(201);
    await dispatch();
    await emails();
    expect(mail.sent).toHaveLength(1);

    await db().query(
      `UPDATE users SET last_invitation_email_at = now() - interval '25 hours'`,
    );
    await emails();
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1].subject).toBe('Dave invited you');
  });

  it('retries an email the provider refused after a growing wait, then gives up after five tries', async () => {
    mail.failFor.add(bob.email);
    await invite();
    await dispatch();
    await emails();
    const one = async () =>
      (
        (await db().query(
          `SELECT email_status, email_attempts, email_error FROM notifications ORDER BY created_at`,
        )) as {
          email_status: string;
          email_attempts: number;
          email_error: string;
        }[]
      )[0];
    expect(await one()).toMatchObject({
      email_status: 'none', // queued for a retry
      email_attempts: 1,
      email_error: 'simulated email failure',
    });
    // Not straight away: the next try waits 5 minutes, then 10, 20 and 40.
    const age = (mins: number) =>
      db().query(
        `UPDATE notifications SET email_at = email_at - make_interval(mins => $1)`,
        [mins],
      );
    for (const [i, wait] of [5, 10, 20, 40].entries()) {
      await age(wait - 1);
      await emails();
      expect((await one()).email_attempts).toBe(i + 1);
      await age(1);
      await emails();
      expect((await one()).email_attempts).toBe(i + 2);
    }
    expect(await one()).toMatchObject({
      email_status: 'failed',
      email_attempts: 5,
    });
    expect(mail.sent).toHaveLength(0);

    // Nothing reached Bob, so his day isn't used up: a new invitation goes
    // out once the provider recovers, and the given-up one stays given up.
    mail.failFor.clear();
    const carol = await registerUser(app, { displayName: 'Carol' });
    await http()
      .post('/invitations')
      .set(auth(carol))
      .send({ inviteeId: bob.id })
      .expect(201);
    await dispatch();
    await emails();
    expect(mail.sent.map((m) => m.subject)).toEqual(['Carol invited you']);
  });

  it('ignores a late email outcome from a worker whose claim was taken over', async () => {
    mail.failFor.add(bob.email);
    await invite();
    await dispatch();
    // While this worker's send hangs, its lease runs out and another worker
    // claims the invitation and Bob's day again.
    const real = mail.send.bind(mail);
    const spy = jest.spyOn(mail, 'send').mockImplementation(async (m) => {
      await db().query(
        `UPDATE notifications SET email_attempts = email_attempts + 1, email_at = now()`,
      );
      await db().query(
        `UPDATE users SET last_invitation_email_at = now() WHERE id = $1`,
        [bob.id],
      );
      return real(m);
    });
    const retryBefore = await counted('invitationEmails', 'retry');
    try {
      await emails();
    } finally {
      spy.mockRestore();
    }
    expect(await counted('invitationEmails', 'retry')).toBe(retryBefore);
    const [row] = (await db().query(
      `SELECT n.email_status, u.last_invitation_email_at
       FROM notifications n JOIN users u ON u.id = n.user_id`,
    )) as { email_status: string; last_invitation_email_at: Date | null }[];
    expect(row.email_status).toBe('pending');
    expect(row.last_invitation_email_at).toBeInstanceOf(Date);
  });

  it('puts an email claim from a crashed worker back in the queue', async () => {
    await invite();
    await dispatch();
    // A worker claimed it and died before recording the outcome.
    await db().query(
      `UPDATE notifications SET email_status = 'pending', email_at = now() - interval '11 minutes'`,
    );
    await db().query(
      `UPDATE users SET last_invitation_email_at = now() - interval '11 minutes' WHERE id = $1`,
      [bob.id],
    );
    await emails();
    expect(mail.sent).toHaveLength(1);
    expect((await notif()).email_status).toBe('sent');
  });

  it('gives back the day of someone left with nothing to claim', async () => {
    const { body } = await invite();
    await dispatch();
    // Alice cancels between the emailer picking Bob and claiming his day,
    // so none of his invitations is left to claim.
    const real = Object.getOwnPropertyDescriptor(
      EntityManager.prototype,
      'query',
    )?.value as (this: EntityManager, ...args: unknown[]) => Promise<unknown>;
    const spy = jest
      .spyOn(EntityManager.prototype, 'query')
      .mockImplementation(async function (
        this: EntityManager,
        sql: string,
        params?: unknown[],
      ) {
        if (sql.includes('UPDATE users SET last_invitation_email_at = now()'))
          await db().query(
            `UPDATE invitations SET status = 'cancelled' WHERE id = $1`,
            [body.id],
          );
        return real.call(this, sql, params);
      });
    try {
      expect(await emails()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const [u] = (await db().query(
      `SELECT last_invitation_email_at FROM users WHERE id = $1`,
      [bob.id],
    )) as { last_invitation_email_at: Date | null }[];
    expect(u.last_invitation_email_at).toBeNull();
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
