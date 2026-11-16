import * as Notifications from 'expo-notifications';

import { api } from '@/api';

import {
  ackPresented,
  createPushPrompt,
  promptMode,
  toNotificationsState,
} from './push';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  IosAuthorizationStatus: {
    NOT_DETERMINED: 0,
    DENIED: 1,
    AUTHORIZED: 2,
    PROVISIONAL: 3,
    EPHEMERAL: 4,
  },
}));
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mockStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mockStore.set(key, value);
  },
}));
jest.mock('@/api', () => ({
  api: {
    notificationDeliveredSigned: jest.fn(),
    notificationDelivered: jest.fn(),
  },
}));

type P = Parameters<typeof toNotificationsState>[0];
const ios = (status: number) =>
  ({ status: 'undetermined', granted: false, canAskAgain: true, ios: { status } }) as unknown as P;
const android = (granted: boolean, canAskAgain: boolean) =>
  ({ status: granted ? 'granted' : 'denied', granted, canAskAgain }) as unknown as P;

describe('toNotificationsState', () => {
  const S = Notifications.IosAuthorizationStatus;

  it('iOS: reads ios.status, so provisional counts as allowed', () => {
    expect(toNotificationsState(ios(S.NOT_DETERMINED), 'ios', false)).toBe('not_asked');
    expect(toNotificationsState(ios(S.AUTHORIZED), 'ios', false)).toBe('allowed');
    expect(toNotificationsState(ios(S.PROVISIONAL), 'ios', false)).toBe('allowed');
    expect(toNotificationsState(ios(S.DENIED), 'ios', false)).toBe('off');
  });

  it('Android 13+: never asked reads as denied, but the OS would still ask', () => {
    expect(toNotificationsState(android(false, true), 'android', false)).toBe('not_asked');
    expect(toNotificationsState(android(false, false), 'android', false)).toBe('off');
    expect(toNotificationsState(android(true, true), 'android', false)).toBe('allowed');
  });

  it('Android: a blocked Invitations channel is off, even with the app allowed', () => {
    expect(toNotificationsState(android(true, true), 'android', true)).toBe('off');
  });
});

describe('promptMode', () => {
  it('asks while the OS would still show its prompt, else sends to Settings', () => {
    expect(promptMode('not_asked')).toBe('ask');
    expect(promptMode('off')).toBe('settings');
    expect(promptMode('allowed')).toBeNull();
  });
});

describe('createPushPrompt', () => {
  const S = Notifications.IosAuthorizationStatus;
  const WEEK = 7 * 24 * 3_600_000;
  const now = Date.now();
  let status: number;
  let show: jest.Mock;

  beforeEach(() => {
    mockStore.clear();
    status = S.NOT_DETERMINED;
    show = jest.fn();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    jest
      .mocked(Notifications.getPermissionsAsync)
      .mockImplementation(async () => ios(status));
  });
  afterEach(() => jest.restoreAllMocks());

  const at = (time: number) => jest.mocked(Date.now).mockReturnValue(time);

  it('refusing the OS prompt quiets it for 7 days, though the app returns to the foreground mid-prompt', async () => {
    const prompt = createPushPrompt(show);
    await prompt.check();
    expect(show).toHaveBeenLastCalledWith('ask');

    let answer!: (p: { granted: boolean }) => void;
    jest
      .mocked(Notifications.requestPermissionsAsync)
      .mockReturnValue(new Promise((r) => (answer = r)) as never);
    const turningOn = prompt.turnOn();
    status = S.DENIED;
    const returning = prompt.check();
    answer({ granted: false });
    await Promise.all([turningOn, returning]);
    expect(show).toHaveBeenLastCalledWith(null);

    at(now + WEEK - 1);
    await prompt.check();
    expect(show).not.toHaveBeenCalledWith('settings');

    at(now + WEEK);
    await prompt.check();
    expect(show).toHaveBeenLastCalledWith('settings');
  });

  it('"Not now" quiets it for 7 days', async () => {
    const prompt = createPushPrompt(show);
    await prompt.check();
    prompt.notNow();

    at(now + WEEK - 1);
    await prompt.check();
    expect(show).toHaveBeenLastCalledWith(null);

    at(now + WEEK);
    await prompt.check();
    expect(show).toHaveBeenLastCalledWith('ask');
  });
});

describe('ackPresented', () => {
  const presented = (...data: unknown[]) =>
    jest.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue(
      data.map((d) => ({ request: { content: { data: d } } })) as never,
    );

  beforeEach(() => jest.clearAllMocks());

  it('acks the pushes iOS showed without waking the app, once each', async () => {
    const ours = { notificationId: 'n1', invitationId: 'i1', ackToken: 't1' };
    presented(ours, { someOtherApp: true });
    await ackPresented();
    await ackPresented(); // back to the foreground again: no second ack
    expect(api.notificationDeliveredSigned).toHaveBeenCalledTimes(1);
    expect(api.notificationDeliveredSigned).toHaveBeenCalledWith('n1', 't1');
  });

  it('never throws, so a failed lookup costs nothing', async () => {
    jest
      .mocked(Notifications.getPresentedNotificationsAsync)
      .mockRejectedValue(new Error('unavailable'));
    await expect(ackPresented()).resolves.toBeUndefined();
  });
});
