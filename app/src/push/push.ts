import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';

import { api } from '@/api';
import type { NotificationsState, PushData } from '@/api/types';

// Everything the app does with push, apart from the hook that wires it to
// React (usePushNotifications.ts), the in-app prompt's view and the
// background task.
//
// The flow, end to end:
//   1. On launch, on a new token, and on returning to the foreground when it
//      changed or 15 minutes have passed, the app tells the server this
//      phone's push token and whether it can show notifications
//      (POST /devices), even when notifications are off: Apple, Google and
//      Expo accept pushes for such a phone and report success, so this report
//      is the only way the server can know.
//   2. An invitation makes the server write a notification to its outbox; a
//      worker pushes it through Expo to every phone of the invitee's that can
//      show it.
//   3. When the push reaches the phone, the app acks it as delivered: from
//      the foreground listener, from the background task, or, if iOS woke
//      neither, the next time the app opens and finds it in Notification
//      Center. When the user taps it, /opened. Without these acks the server
//      can't tell a delivered push from a lost one.
//   4. If no phone of the invitee's can show it, the server emails them
//      instead (see the API's ADR 0006). The in-app prompt (PushPrompt) is
//      how a user who still opens the app turns notifications back on.

const log = (...args: unknown[]) => console.log('[push]', ...args);

// Show pushes while the app is open too: the user may be on another tab.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Reads our payload out of a push, or null if it isn't one of ours. */
export function parsePushData(data: unknown): PushData | null {
  const d = data as Partial<PushData> | null | undefined;
  const isId = (v: unknown) => typeof v === 'string' && v.length > 0;
  return isId(d?.notificationId) && isId(d?.invitationId)
    ? (d as PushData)
    : null;
}

// --- Permission -------------------------------------------------------------

type Permission = Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>;

/**
 * What this phone will do with our pushes, in the three states the server
 * and the prompt care about:
 * - allowed: they're shown.
 * - not_asked: not allowed yet, and the OS would still show its prompt.
 * - off: only Settings can turn them on.
 *
 * iOS: read `ios.status`, not `granted`, which is false for provisional
 * authorisation even though those pushes reach Notification Center. The
 * system prompt appears once; after "Don't Allow" it never appears again.
 * Android 13+: an app that has never asked reads as `denied` with
 * `canAskAgain`, and the OS allows one more ask after a first refusal. A
 * user can also block just our "Invitations" channel while the app stays
 * allowed, which Expo's permission doesn't show.
 */
export function toNotificationsState(
  p: Permission,
  os: string,
  channelBlocked: boolean,
): NotificationsState {
  if (os === 'ios') {
    const s = p.ios?.status;
    const { AUTHORIZED, PROVISIONAL, EPHEMERAL, DENIED } =
      Notifications.IosAuthorizationStatus;
    if (s === AUTHORIZED || s === PROVISIONAL || s === EPHEMERAL) return 'allowed';
    return s === DENIED ? 'off' : 'not_asked';
  }
  if (!p.granted) return p.canAskAgain ? 'not_asked' : 'off';
  return channelBlocked ? 'off' : 'allowed';
}

export async function notificationsState(): Promise<NotificationsState> {
  const p = await Notifications.getPermissionsAsync();
  let channelBlocked = false;
  if (Platform.OS === 'android' && p.granted) {
    const channel = await Notifications.getNotificationChannelAsync('default');
    channelBlocked = channel?.importance === Notifications.AndroidImportance.NONE;
  }
  return toNotificationsState(p, Platform.OS, channelBlocked);
}

export type PromptMode = 'ask' | 'settings' | null;

/** What the in-app prompt offers: the OS prompt while it would still appear, else Settings. */
export function promptMode(state: NotificationsState): PromptMode {
  if (state === 'not_asked') return 'ask';
  if (state === 'off') return 'settings';
  return null;
}

/**
 * Opens the system page where this app's notifications are turned on. On
 * Android that page directly; on iOS the app's page in Settings, where
 * Notifications is the first row. Call it only from the user's own tap.
 */
export async function openNotificationSettings(): Promise<void> {
  const pkg = Constants.expoConfig?.android?.package;
  if (Platform.OS === 'android' && pkg) {
    try {
      await Linking.sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', [
        { key: 'android.provider.extra.APP_PACKAGE', value: pkg },
      ]);
      return;
    } catch {
      // Some Android builds don't have that page: fall through to app info.
    }
  }
  await Linking.openSettings();
}

/** Shows the OS prompt. Call only after the app has said why. */
export async function requestPermission(): Promise<boolean> {
  // Android 13+ shows the prompt only once a channel exists.
  await ensureAndroidChannel();
  return (await Notifications.requestPermissionsAsync()).granted;
}

// Pushes that name no channel land in Expo's "Default" channel. Creating it
// ourselves makes it heads-up (HIGH) with a readable name in Settings.
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Invitations',
    importance: Notifications.AndroidImportance.HIGH,
  });
}

// --- Device registration ----------------------------------------------------

// Returned by POST /devices; DELETE /devices/:id needs it on sign-out. Memory
// only: if this launch never registered, or sign-out happens offline, the
// device stays active on the server and keeps getting this user's pushes.
let deviceId: string | null = null;
// Exchanging the native token for an Expo token is a network call, so it's
// done once per launch, or again when APNs/FCM rotate the native token.
let expoPushToken: string | null = null;
// Returning to the foreground re-reports the phone, but only when something
// changed or the last report is 15 minutes old.
let lastReport: { key: string; at: number } | null = null;
const REPORT_EVERY_MS = 15 * 60_000;

/**
 * Tells the server this phone's push token and notifications state. Runs on
 * every launch, return to the foreground and token change, and posts when
 * the token or state changed or 15 minutes have passed, so the server learns
 * when the user turns notifications on or off in Settings.
 * Never throws: push is an extra, and the app must work without it
 * (simulator, no EAS project yet, offline).
 */
export async function registerDevice(
  devicePushToken?: Notifications.DevicePushToken,
): Promise<void> {
  try {
    const notifications = await notificationsState();
    if (notifications === 'allowed') await ensureAndroidChannel();

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) {
      log('no EAS projectId (run `eas init`), skipping push registration');
      return;
    }

    // Expo exchanges the native APNs/FCM token for an Expo token. Neither
    // platform needs notification permission for this; it fails on
    // simulators without push support and when offline.
    if (!expoPushToken || devicePushToken) {
      expoPushToken = (
        await Notifications.getExpoPushTokenAsync({ projectId, devicePushToken })
      ).data;
    }
    const key = `${expoPushToken}|${notifications}`;
    if (lastReport?.key === key && Date.now() - lastReport.at < REPORT_EVERY_MS) {
      return;
    }
    const device = await api.registerDevice({
      expoPushToken,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      appVersion: Constants.expoConfig?.version,
      notifications,
    });
    deviceId = device.id;
    lastReport = { key, at: Date.now() };
    log('registered device', device.id, notifications);
  } catch (e) {
    log('push registration skipped:', e instanceof Error ? e.message : e);
  }
}

/** Sign-out: stop the server pushing this user's invitations to this phone. */
export async function unregisterDevice(): Promise<void> {
  lastReport = null; // the next account to sign in here reports afresh
  if (!deviceId) return;
  const id = deviceId;
  deviceId = null;
  await api.unregisterDevice(id);
}

// --- In-app prompt ----------------------------------------------------------

// "Not now", or a refusal at the OS prompt, quiets the prompt for a week:
// asking again sooner is nagging, and Google's guidance is not to send
// someone to Settings straight after they said no.
const SNOOZE_KEY = 'pushPromptSnoozedUntil';
const SNOOZE_MS = 7 * 24 * 3_600_000;
const snooze = () =>
  SecureStore.setItemAsync(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
const snoozed = async () =>
  Number((await SecureStore.getItemAsync(SNOOZE_KEY)) ?? 0) > Date.now();

/**
 * What the inbox prompt (PushPrompt) does, without React: `show` gets what
 * it should offer now.
 *
 * The OS prompt takes the app out of the foreground, and its return runs a
 * check while turnOn() still waits for the answer. That check would read the
 * snooze before a refusal writes it, so checks are skipped until the answer
 * is stored.
 */
export function createPushPrompt(show: (mode: PromptMode) => void) {
  let asking = false;
  return {
    /** On mount and on every return to the foreground. */
    async check() {
      if (asking) return;
      const next = (await snoozed()) ? null : promptMode(await notificationsState());
      if (!asking) show(next);
    },

    async turnOn() {
      show(null);
      asking = true;
      try {
        if (await requestPermission()) await registerDevice();
        else await snooze();
      } finally {
        asking = false;
      }
    },

    notNow() {
      show(null);
      void snooze();
    },
  };
}

// --- Delivery receipts --------------------------------------------------------

// The foreground listener and the background task can both see the same push.
// The server ignores repeats, but there's no need to send them.
const deliveredSent = new Set<string>();

export async function ackDelivered(data: PushData): Promise<void> {
  if (deliveredSent.has(data.notificationId)) return;
  deliveredSent.add(data.notificationId);
  try {
    if (data.ackToken) {
      await api.notificationDeliveredSigned(data.notificationId, data.ackToken);
    } else {
      await api.notificationDelivered(data.notificationId);
    }
  } catch (e) {
    deliveredSent.delete(data.notificationId);
    log('delivered ack failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Acks every push of ours still in Notification Center. iOS shows a push
 * without waking the app when it's rationing background time or the user
 * force-quit the app, so neither the listener nor the background task ran.
 * Called whenever the app comes to the foreground: late, but true, and the
 * server only moves a notification forward, so repeats are harmless.
 */
export async function ackPresented(): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        .map((n) => parsePushData(n.request.content.data))
        .filter((d): d is PushData => d !== null)
        .map(ackDelivered),
    );
  } catch (e) {
    log('presented ack failed:', e instanceof Error ? e.message : e);
  }
}

export async function ackOpened(data: PushData): Promise<void> {
  try {
    await api.notificationOpened(data.notificationId);
  } catch (e) {
    log('opened ack failed:', e instanceof Error ? e.message : e);
  }
}
