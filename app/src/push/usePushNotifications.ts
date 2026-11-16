import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { keys, queryClient } from '@/api/queries';

import {
  ackDelivered,
  ackOpened,
  ackPresented,
  parsePushData,
  registerDevice,
} from './push';

/** Connects push to the running app. Does nothing while signed out. */
export function usePushNotifications(signedIn: boolean) {
  // Report the phone on every start: the token can change between launches,
  // and the server uses the call to know the device is still alive. Again if
  // APNs/FCM rotate the token while the app runs.
  useEffect(() => {
    if (!signedIn) return;
    void registerDevice();
    const sub = Notifications.addPushTokenListener(
      (token) => void registerDevice(token),
    );
    return () => sub.remove();
  }, [signedIn]);

  // On every return to the foreground: report the notifications state again
  // (the user may have changed it in Settings), and ack the pushes iOS
  // displayed without waking the app.
  useEffect(() => {
    if (!signedIn) return;
    void ackPresented();
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void registerDevice();
      void ackPresented();
    });
    return () => sub.remove();
  }, [signedIn]);

  // A push arrived while the app is open: acknowledge it, and refetch what
  // it's about so the inbox is current when the user looks.
  useEffect(() => {
    if (!signedIn) return;
    const sub = Notifications.addNotificationReceivedListener((notification) => {
      const data = parsePushData(notification.request.content.data);
      if (!data) return;
      void ackDelivered(data);
      void queryClient.invalidateQueries({ queryKey: keys.invitations });
      void queryClient.invalidateQueries({
        queryKey: keys.invitation(data.invitationId),
      });
    });
    return () => sub.remove();
  }, [signedIn]);

  // The user tapped a push. This hook covers a tap while the app runs and the
  // tap that launched it (cold start), which happened before any listener
  // existed. When signed out, the tap waits here until the user signs in.
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (!signedIn || !response) return;
    // Handle each tap once; this also resets the hook to null.
    Notifications.clearLastNotificationResponse();
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
      return;
    }
    const data = parsePushData(response.notification.request.content.data);
    if (!data) return;
    void ackOpened(data);
    router.push(`/i/${data.invitationId}`);
  }, [signedIn, response]);
}
