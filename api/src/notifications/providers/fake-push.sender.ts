import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/env.validation';
import {
  DEVICE_NOT_REGISTERED,
  PushMessage,
  PushResult,
  PushSender,
  ReceiptResult,
  TRANSPORT_ERROR,
} from './push-sender';

export type FakeBehaviour =
  | 'ok'
  | 'dead'
  | 'flaky'
  | 'no_credentials'
  | 'receipt_error'
  | 'receipt_rate_limited';

// Stands in for Expo in tests and load tests. Behaviour is chosen per push
// token, so one test can have a healthy phone and an uninstalled one.
@Injectable()
export class FakePushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  private readonly behaviour = new Map<string, FakeBehaviour>();
  private readonly receipts = new Map<string, ReceiptResult>();
  private readonly latencyMs: number;

  constructor(config: ConfigService<AppConfig, true>) {
    this.latencyMs = config.get('FAKE_PUSH_LATENCY_MS', { infer: true });
  }

  setBehaviour(token: string, b: FakeBehaviour) {
    this.behaviour.set(token, b);
  }

  reset() {
    this.sent.length = 0;
    this.behaviour.clear();
    this.receipts.clear();
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    // Mirrors ExpoPushSender: chunks of 100, four requests in flight, so a
    // batch costs one round trip per four chunks.
    if (this.latencyMs > 0) {
      const rounds = Math.ceil(Math.ceil(messages.length / 100) / 4);
      await new Promise((r) => setTimeout(r, this.latencyMs * rounds));
    }
    return messages.map((m): PushResult => {
      const b = this.behaviour.get(m.to) ?? 'ok';
      if (b === 'dead') {
        return {
          ok: false,
          error: DEVICE_NOT_REGISTERED,
          message: 'not registered',
          retryable: false,
        };
      }
      if (b === 'no_credentials') {
        // What Expo answers when the app has no APNs key on EAS.
        return {
          ok: false,
          error: 'InvalidCredentials',
          message: 'Could not find APNs credentials',
          retryable: true,
        };
      }
      if (b === 'flaky') {
        return {
          ok: false,
          error: TRANSPORT_ERROR,
          message: 'simulated outage',
          retryable: true,
        };
      }
      this.sent.push(m);
      const ticketId = randomUUID();
      this.receipts.set(
        ticketId,
        b === 'receipt_error'
          ? { status: 'error', error: DEVICE_NOT_REGISTERED, message: 'gone' }
          : b === 'receipt_rate_limited'
            ? {
                status: 'error',
                error: 'MessageRateExceeded',
                message: 'slow down',
              }
            : { status: 'ok' },
      );
      return { ok: true, ticketId };
    });
  }

  getReceipts(ticketIds: string[]): Promise<Record<string, ReceiptResult>> {
    const out: Record<string, ReceiptResult> = {};
    for (const id of ticketIds) {
      const r = this.receipts.get(id);
      if (r) out[id] = r;
    }
    return Promise.resolve(out);
  }
}
