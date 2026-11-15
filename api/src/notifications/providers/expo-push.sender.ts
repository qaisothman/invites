import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/env.validation';
import { MetricsService } from '../../metrics/metrics.service';
import {
  CREDENTIAL_ERRORS,
  EXPO_ACCESS_DENIED,
  isRetryableProviderError,
  NOT_SENT,
  PushMessage,
  PushResult,
  PushSender,
  ReceiptResult,
  TRANSPORT_ERROR,
} from './push-sender';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const SEND_CHUNK = 100; // Expo's maximum messages per request
const RECEIPT_CHUNK = 1000; // Expo's maximum ids per receipts request
const PARALLEL_REQUESTS = 4;
// Each request's own limit. A send request starts only while a whole
// TIMEOUT_MS still fits before the caller's deadline, so none is in flight
// past it, however many chunks there are or how many get resent one by one.
export const TIMEOUT_MS = 10_000;

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

// Plain fetch instead of expo-server-sdk: one less dependency, and every
// retry and timeout decision is visible here.
@Injectable()
export class ExpoPushSender implements PushSender {
  private readonly logger = new Logger(ExpoPushSender.name);
  private readonly headers: Record<string, string>;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly metrics: MetricsService,
  ) {
    const token = config.get('EXPO_ACCESS_TOKEN', { infer: true });
    this.headers = {
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  async send(messages: PushMessage[], deadline: number): Promise<PushResult[]> {
    const chunks = chunk(messages, SEND_CHUNK);
    const results = await mapLimited(chunks, PARALLEL_REQUESTS, (c) =>
      this.sendChunk(c, deadline),
    );
    return results.flat();
  }

  private async sendChunk(
    messages: PushMessage[],
    deadline: number,
  ): Promise<PushResult[]> {
    const failAll = (
      message: string,
      retryable: boolean,
      error = TRANSPORT_ERROR,
    ): PushResult[] =>
      messages.map(() => ({ ok: false, error, message, retryable }));
    // Too late to start: Expo never sees it, and the next claim sends it.
    if (Date.now() + TIMEOUT_MS > deadline)
      return failAll('send deadline reached before sending', true, NOT_SENT);
    const end = this.metrics.pushRequest.startTimer({ op: 'send' });
    // Covers the answer's body as well as its headers.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(SEND_URL, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(
          messages.map((m) => ({
            ...m,
            sound: 'default',
            priority: 'high',
            // Android: the channel the app creates at startup. A push naming
            // a channel the phone doesn't have is never shown.
            channelId: 'default',
            // iOS: wake the app's background task, which confirms delivery.
            contentAvailable: true,
          })),
        ),
        signal: abort.signal,
      });
      // Rate limited or Expo is having a bad moment: try again later.
      if (res.status === 429 || res.status >= 500) {
        end({ outcome: `http_${res.status}` });
        return failAll(`Expo HTTP ${res.status}`, true);
      }
      // Our access token is missing, revoked or wrong: a credential fault,
      // retried like the APNs and FCM ones.
      if (res.status === 401 || res.status === 403) {
        end({ outcome: `http_${res.status}` });
        this.logger.error(`Expo refused the access token (HTTP ${res.status})`);
        return failAll(`Expo HTTP ${res.status}`, true, EXPO_ACCESS_DENIED);
      }
      // Expo rejected the whole request and accepted none of it, for one bad
      // message or tokens from two Expo projects: send each message on its
      // own, so one can't fail the others.
      if (res.status === 400 && messages.length > 1) {
        end({ outcome: 'rejected' });
        clearTimeout(timer);
        const one = (m: PushMessage) => this.sendChunk([m], deadline);
        return (await mapLimited(messages, PARALLEL_REQUESTS, one)).flat();
      }
      const body = (await res.json()) as {
        data?: ExpoTicket[];
        errors?: { code: string; message: string }[];
      };
      if (!res.ok || !body.data || body.data.length !== messages.length) {
        // A rejected message, or an answer that doesn't match the request,
        // won't fix itself by retrying.
        end({ outcome: 'rejected' });
        const why =
          body.errors?.map((e) => e.code).join(',') ?? `HTTP ${res.status}`;
        this.logger.error(`Expo rejected a send request: ${why}`);
        return failAll(`Expo rejected request: ${why}`, false);
      }
      end({ outcome: 'ok' });
      const results = body.data.map((t): PushResult =>
        t.status === 'ok' && t.id
          ? { ok: true, ticketId: t.id }
          : {
              ok: false,
              error: t.details?.error ?? 'Unknown',
              message: t.message ?? 'Unknown Expo error',
              // Rate limiting and broken credentials clear up; a bad
              // message or a dead device doesn't.
              retryable: isRetryableProviderError(t.details?.error),
            },
      );
      const credentialError = results.find(
        (r) => !r.ok && CREDENTIAL_ERRORS.includes(r.error),
      );
      if (credentialError && !credentialError.ok) {
        // Not one bad message: every push fails until this is fixed.
        this.logger.error(
          `Push credentials are missing or invalid (${credentialError.error}): ${credentialError.message}`,
        );
      }
      return results;
    } catch (e) {
      // Network failure or timeout. Expo may or may not have received it; we
      // retry, accepting a rare duplicate over a lost notification.
      end({ outcome: 'network_error' });
      return failAll(e instanceof Error ? e.message : 'network error', true);
    } finally {
      clearTimeout(timer);
    }
  }

  async getReceipts(
    ticketIds: string[],
  ): Promise<Record<string, ReceiptResult>> {
    const out: Record<string, ReceiptResult> = {};
    for (const ids of chunk(ticketIds, RECEIPT_CHUNK)) {
      const end = this.metrics.pushRequest.startTimer({ op: 'receipts' });
      const res = await fetch(RECEIPTS_URL, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      end({ outcome: res.ok ? 'ok' : `http_${res.status}` });
      if (!res.ok) throw new Error(`Expo receipts HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Record<string, ExpoTicket> };
      for (const [id, r] of Object.entries(body.data ?? {})) {
        out[id] =
          r.status === 'ok'
            ? { status: 'ok' }
            : {
                status: 'error',
                error: r.details?.error ?? 'Unknown',
                message: r.message ?? '',
              };
      }
    }
    return out;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

// Runs fn over items with at most `limit` in flight, preserving order.
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
