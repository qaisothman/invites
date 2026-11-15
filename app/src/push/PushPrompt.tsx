import { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/ui/components';
import { space, useTheme } from '@/ui/theme';

import { createPushPrompt, openNotificationSettings } from './push';
import type { PromptMode } from './push';

/**
 * Shown at the top of the inbox, where invitations arrive, while this phone
 * can't show our notifications. Never a pop-up on launch and never a gate:
 * everything works without push (App Store rule 4.5.4), and the user can
 * always dismiss it.
 * - Not asked yet: explains why, then shows the OS prompt.
 * - Off: offers Settings, the only way back once the OS stops asking.
 * Re-checked on every return to the foreground, so it disappears when the
 * user comes back from Settings with notifications on.
 */
export function PushPrompt() {
  const t = useTheme();
  const [mode, setMode] = useState<PromptMode>(null);
  const [prompt] = useState(() => createPushPrompt(setMode));

  useEffect(() => {
    void prompt.check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void prompt.check();
    });
    return () => sub.remove();
  }, [prompt]);

  if (!mode) return null;

  return (
    <View style={[styles.box, { backgroundColor: t.surface }]}>
      <Text style={[styles.text, { color: t.text }]}>
        {mode === 'ask'
          ? 'Turn on notifications to hear about new invitations right away.'
          : 'Notifications are off for Invites. Turn them on in Settings to hear about new invitations right away.'}
      </Text>
      <View style={styles.actions}>
        {mode === 'ask' ? (
          <Button title="Turn on" onPress={() => void prompt.turnOn()} />
        ) : (
          <Button title="Open Settings" onPress={() => void openNotificationSettings()} />
        )}
        <Button title="Not now" variant="secondary" onPress={prompt.notNow} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { margin: space.md, padding: space.md, borderRadius: 12, gap: 12 },
  text: { fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: space.sm },
});
