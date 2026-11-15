// The dispatcher depends on this interface, not on Expo. Production binds it
// to ExpoPushSender; tests and load tests bind it to FakePushSender. Swapping
// providers (to FCM/APNs directly, or OneSignal) means one new class.
export const PUSH_SENDER = Symbol('PUSH_SENDER');

export interface PushMessage {
  to: string; // Expo push token
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export type PushResult =
  | { ok: true; ticketId: string }
  | { ok: false; error: string; message: string; retryable: boolean };

export type ReceiptResult =
  { status: 'ok' } | { status: 'error'; error: string; message: string };

export interface PushSender {
  // One result per message, in the same order. Nothing is still being sent at
  // `deadline` (epoch ms): a message whose request couldn't finish by then
  // isn't sent, and comes back as NOT_SENT.
  send(messages: PushMessage[], deadline: number): Promise<PushResult[]>;
  // Receipts that aren't ready yet are simply absent from the result.
  getReceipts(ticketIds: string[]): Promise<Record<string, ReceiptResult>>;
}

// Expo's ticket and receipt error codes we act on.
export const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';
export const TRANSPORT_ERROR = 'TransportError';
export const MESSAGE_RATE_EXCEEDED = 'MessageRateExceeded';

// Expo refused our access token (HTTP 401 or 403). Our own code, not Expo's.
export const EXPO_ACCESS_DENIED = 'ExpoAccessDenied';

// The send deadline came before this message's request could start, so Expo
// never saw it. Our own code; retryable, and it says nothing about the message.
export const NOT_SENT = 'NotSent';

// Our push setup is wrong: no APNs key for the bundle id, the FCM key
// doesn't match the app, or Expo refused our access token. Every message
// fails until someone fixes it, so these are retried with backoff rather
// than failed; once the credentials are fixed, the queue drains on its own.
export const CREDENTIAL_ERRORS = [
  'InvalidCredentials',
  'MismatchSenderId',
  EXPO_ACCESS_DENIED,
];

// Errors on the provider's side, not the message's: worth sending again
// later, at the ticket or the receipt stage, without using up attempts.
export const RETRYABLE_PROVIDER_ERRORS = [
  MESSAGE_RATE_EXCEEDED,
  ...CREDENTIAL_ERRORS,
];
export const isRetryableProviderError = (code: string | undefined) =>
  code !== undefined && RETRYABLE_PROVIDER_ERRORS.includes(code);
