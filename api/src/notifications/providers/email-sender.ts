import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/env.validation';

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailMessage {
  from: string; // EMAIL_FROM
  to: string;
  subject: string;
  text: string;
  // For example List-Unsubscribe, so mail apps can offer one-tap unsubscribe.
  headers: Record<string, string>;
}

export interface EmailSender {
  // Resolves with the provider's message id; rejects if the send failed.
  send(message: EmailMessage): Promise<string>;
}

// The default until a provider is connected: writes each email to the log
// instead of sending it. Outside production that's the whole email, with the
// unsubscribe token cut, so a developer can read it and follow its link; in
// production, only the masked address and the subject. A provider (SES,
// Postmark, Resend) is one more class; docs/08-sending-real-email.md lists what it
// needs.
@Injectable()
export class LogEmailSender implements EmailSender {
  private readonly logger = new Logger('Email');
  private readonly full: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    this.full = config.get('NODE_ENV', { infer: true }) !== 'production';
  }

  send(message: EmailMessage): Promise<string> {
    const [name, domain] = message.to.split('@');
    const head = `to ${name.slice(0, 1)}•••@${domain}: ${message.subject}`;
    const body = message.text.replace(/([?&]t=)[\w-]+/g, '$1…');
    this.logger.log(this.full ? `${head}\n${body}` : head);
    return Promise.resolve(`log-${Date.now()}`);
  }
}

@Injectable()
export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failFor = new Set<string>();

  send(message: EmailMessage): Promise<string> {
    if (this.failFor.has(message.to))
      return Promise.reject(new Error('simulated email failure'));
    this.sent.push(message);
    return Promise.resolve(`fake-${this.sent.length}`);
  }

  reset() {
    this.sent.length = 0;
    this.failFor.clear();
  }
}
