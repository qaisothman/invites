import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/env.validation';
import { MetricsService } from '../../metrics/metrics.service';
import { ExpoPushSender, TIMEOUT_MS } from './expo-push.sender';
import {
  EXPO_ACCESS_DENIED,
  NOT_SENT,
  PushMessage,
  TRANSPORT_ERROR,
} from './push-sender';

const message = (to: string): PushMessage => ({
  to,
  title: 't',
  body: 'b',
  data: {},
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });
// Far enough away for every test that isn't about the deadline.
const later = () => Date.now() + 3_600_000;

describe('ExpoPushSender', () => {
  const config = {
    get: () => undefined,
  } as unknown as ConfigService<AppConfig, true>;
  const metrics = {
    pushRequest: { startTimer: () => () => undefined },
  } as unknown as MetricsService;
  const sender = new ExpoPushSender(config, metrics);
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('retries a refused access token as a credential error', async () => {
    fetchMock.mockResolvedValue(json(401, { errors: [] }));
    const results = await sender.send([message('a'), message('b')], later());
    expect(results).toEqual([
      expect.objectContaining({ error: EXPO_ACCESS_DENIED, retryable: true }),
      expect.objectContaining({ error: EXPO_ACCESS_DENIED, retryable: true }),
    ]);
  });

  it('sends each message alone when Expo rejects the request, so one bad message fails alone', async () => {
    fetchMock.mockImplementation((_url, init: RequestInit) => {
      const sent = JSON.parse(init.body as string) as PushMessage[];
      if (sent.length > 1 || sent[0].to === 'bad')
        return Promise.resolve(json(400, { errors: [{ code: 'BAD' }] }));
      return Promise.resolve(
        json(200, { data: [{ status: 'ok', id: `ticket-${sent[0].to}` }] }),
      );
    });
    const results = await sender.send(
      [message('a'), message('bad'), message('c')],
      later(),
    );
    expect(results).toEqual([
      { ok: true, ticketId: 'ticket-a' },
      expect.objectContaining({ ok: false, retryable: false }),
      { ok: true, ticketId: 'ticket-c' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not send again when an accepted request is answered oddly', async () => {
    fetchMock.mockResolvedValue(
      json(200, { data: [{ status: 'ok', id: 'x' }] }),
    );
    const results = await sender.send([message('a'), message('b')], later());
    expect(results.every((r) => !r.ok && !r.retryable)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('the deadline', () => {
    // The dispatcher's: 40 s after the claim, inside its 60 s lease.
    const DEADLINE_MS = 40_000;
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => message(`m${i}`));
    let lastEnd: number;

    beforeEach(() => {
      jest.useFakeTimers();
      lastEnd = 0;
    });
    afterEach(() => jest.useRealTimers());

    const run = async (n: number) => {
      const deadline = Date.now() + DEADLINE_MS;
      const pending = sender.send(many(n), deadline);
      await jest.advanceTimersByTimeAsync(10 * DEADLINE_MS);
      return { results: await pending, deadline };
    };

    it('is never passed by a slow Expo rejecting every batch, which costs the most requests', async () => {
      // Each request takes just under its timeout; every batch is rejected,
      // so each is resent one message at a time.
      fetchMock.mockImplementation((_url, init: RequestInit) => {
        const sent = JSON.parse(init.body as string) as PushMessage[];
        return new Promise((resolve) =>
          setTimeout(() => {
            lastEnd = Math.max(lastEnd, Date.now());
            resolve(
              sent.length > 1
                ? json(400, { errors: [{ code: 'BAD' }] })
                : json(200, { data: [{ status: 'ok', id: 't' }] }),
            );
          }, TIMEOUT_MS - 1),
        );
      });
      const { results, deadline } = await run(1000);
      expect(lastEnd).toBeGreaterThan(0);
      expect(lastEnd).toBeLessThanOrEqual(deadline);
      const sent = results.filter((r) => r.ok).length;
      expect(sent).toBeGreaterThan(0);
      expect(results.filter((r) => !r.ok && r.error === NOT_SENT)).toHaveLength(
        1000 - sent,
      );
      expect(results.every((r) => r.ok || r.retryable)).toBe(true);
    });

    it('is never passed by requests that hang until they time out', async () => {
      fetchMock.mockImplementation(
        (_url, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal?.addEventListener('abort', () => {
              lastEnd = Math.max(lastEnd, Date.now());
              reject(new Error('aborted'));
            }),
          ),
      );
      // 20 batches, 4 at a time: four rounds of 10 s fit before the deadline.
      const { results, deadline } = await run(2000);
      expect(lastEnd).toBeLessThanOrEqual(deadline);
      const errors = (code: string) =>
        results.filter((r) => !r.ok && r.error === code).length;
      expect(errors(TRANSPORT_ERROR)).toBe(1600);
      expect(errors(NOT_SENT)).toBe(400);
    });
  });
});
