import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { session } from '@/auth/session';

import { ackDelivered, notificationsState, parsePushData } from './push';

// Acknowledges delivery of pushes that arrive while the app is in the
// background or not running. (In the foreground, usePushNotifications does
// it; a push seen by both is acked once.) Imported by index.ts so it's
// defined before anything else runs.
//
// This is best effort, and the platforms decide when it runs:
// - iOS starts it only for pushes sent with `contentAvailable: true` (plus
//   the remote-notification background mode, set in app.config.ts). It
//   throttles them (Apple suggests no more than two or three an hour) and
//   never runs them for an app the user force-quit.
// - Android runs it while the app is in the background; once the app has
//   been killed, only a data-only (headless) push starts it, and Doze mode
//   can hold it back.
// So the server can't rely on this ack alone. It also reads Expo's push
// receipts (did Apple/Google accept it?). Whether an invitation is emailed
// doesn't depend on this ack at all: only on whether any phone of the
// invitee's could show the push.

const TASK = 'invites-background-notification';
const { NewData, NoData } = Notifications.BackgroundNotificationTaskResult;

TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  TASK,
  async ({ data }) => {
    // A tap (Android, app in background): handled when the app opens.
    if (!data || 'actionIdentifier' in data) return NoData;

    // Both platforms hand over the push's `data` as a JSON string.
    let push = null;
    try {
      push = parsePushData(JSON.parse(String(data.data?.dataString)));
    } catch {
      return NoData;
    }
    if (!push) return NoData;

    // iOS can wake this task for a push it won't show, when notifications
    // are off. Acking that would count it as delivered to someone who never
    // saw it.
    if ((await notificationsState()) !== 'allowed') return NoData;

    // The push carries a token signed for this notification, so the ack
    // needs no session. That matters here: this may be a fresh JS runtime,
    // and refreshing the session from it could race the app's own refresh.
    if (!push.ackToken) {
      // A push without an ackToken can only be confirmed with the session.
      await session.load();
      if (session.getStatus() !== 'signedIn') return NoData;
    }
    await ackDelivered(push);
    return NewData;
  },
);

Notifications.registerTaskAsync(TASK).catch((e: unknown) =>
  console.log('[push] background task not registered:', e),
);
