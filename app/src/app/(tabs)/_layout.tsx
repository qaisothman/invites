import { NativeTabs } from 'expo-router/native-tabs';

import { useTheme } from '@/ui/theme';

// Native tab bars (UITabBarController / Material bottom navigation), so they
// look and behave like the platform's own. Icons: SF Symbols on iOS,
// Material Symbols on Android.
export default function TabsLayout() {
  const t = useTheme();
  return (
    <NativeTabs tintColor={t.accent}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Received</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="tray" md="inbox" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="sent">
        <NativeTabs.Trigger.Label>Sent</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="paperplane" md="send" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="invite">
        <NativeTabs.Trigger.Label>Invite</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.badge.plus" md="person_add" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.crop.circle" md="account_circle" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
