import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { api } from '@/api';
import { keys, queryClient, useMe } from '@/api/queries';
import type { Me } from '@/api/types';
import { signOut } from '@/auth/auth';
import { Button, ErrorState, Field, FormError, Loading, Screen } from '@/ui/components';
import { space, useTheme } from '@/ui/theme';

export default function ProfileScreen() {
  const me = useMe();
  return (
    <Screen title="Profile">
      {me.isPending ? (
        <Loading />
      ) : me.isError ? (
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      ) : (
        <ProfileForm me={me.data} />
      )}
    </Screen>
  );
}

// A separate component so the form state starts from loaded data.
function ProfileForm({ me }: { me: Me }) {
  const t = useTheme();
  const [displayName, setDisplayName] = useState(me.displayName);
  const [signingOut, setSigningOut] = useState(false);

  const save = useMutation({
    mutationFn: () => api.updateMe({ displayName: displayName.trim() }),
    onSuccess: (updated) => queryClient.setQueryData(keys.me, updated),
  });
  const changed = displayName.trim() !== me.displayName;

  // Saved as soon as it's flipped, like any system switch. It shows the
  // server's value (an unsubscribe from an email link shows up here), and the
  // value being saved while a save is in flight.
  const saveEmails = useMutation({
    mutationFn: (on: boolean) => api.updateMe({ invitationEmails: on }),
    onSuccess: (updated) => queryClient.setQueryData(keys.me, updated),
  });
  const emails = saveEmails.isPending
    ? (saveEmails.variables as boolean)
    : me.invitationEmails;

  return (
    <ScrollView
      contentContainerStyle={styles.form}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.readOnly}>
        <Text style={[styles.label, { color: t.muted }]}>Email</Text>
        <Text style={[styles.value, { color: t.text }]}>{me.email}</Text>
      </View>
      <Field
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        maxLength={80}
        textContentType="name"
        autoComplete="name"
      />
      <FormError error={save.error} />
      {save.isSuccess && !changed ? (
        <Text style={[styles.saved, { color: t.muted }]}>Saved.</Text>
      ) : null}
      <Button
        title="Save"
        onPress={() => save.mutate()}
        loading={save.isPending}
        disabled={!changed || !displayName.trim()}
      />
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={[styles.value, { color: t.text }]}>Invitation emails</Text>
          <Text style={[styles.hint, { color: t.muted }]}>
            Only when notifications can't reach any of your phones: who invited you, and a link. Never marketing.
          </Text>
        </View>
        <Switch
          value={emails}
          onValueChange={(on) => saveEmails.mutate(on)}
          accessibilityLabel="Invitation emails"
        />
      </View>
      <FormError error={saveEmails.error} />
      <View style={styles.signOut}>
        <Button
          title="Sign out"
          variant="secondary"
          loading={signingOut}
          onPress={() => {
            setSigningOut(true);
            void signOut();
          }}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  form: { padding: space.md, gap: space.md },
  readOnly: { gap: 6 },
  label: { fontSize: 13, fontWeight: '500' },
  value: { fontSize: 17 },
  saved: { fontSize: 15 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md },
  switchText: { flex: 1, gap: 4 },
  hint: { fontSize: 13, lineHeight: 18 },
  signOut: { marginTop: space.lg },
});
