import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { api } from '@/api';
import { keys, queryClient } from '@/api/queries';
import { Button, Field, FormError, Screen } from '@/ui/components';
import { space, useTheme } from '@/ui/theme';

const MAX_MESSAGE = 280;

export default function InviteScreen() {
  const t = useTheme();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  const invite = useMutation({
    mutationFn: async () => {
      // Invitations are addressed by user id. The lookup only matches an
      // exact email, so it can't be used to browse who is a member.
      const invitee = await api.lookupUser(email.trim());
      await api.createInvitation({
        inviteeId: invitee.id,
        message: message.trim() || undefined,
      });
      return invitee;
    },
    onSuccess: () => {
      setEmail('');
      setMessage('');
      void queryClient.invalidateQueries({ queryKey: keys.box('sent') });
    },
  });

  return (
    <Screen title="Invite">
      <ScrollView
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Field
          label="Their email"
          value={email}
          onChangeText={(text) => {
            setEmail(text);
            invite.reset(); // clear the last result once they start a new one
          }}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          placeholder="name@example.com"
        />
        <Field
          label="Message (optional)"
          value={message}
          onChangeText={setMessage}
          multiline
          maxLength={MAX_MESSAGE}
          hint={`${message.length}/${MAX_MESSAGE}`}
        />
        {/* The API's errors read well as they are: "No member with that
            email", "You already have an open invitation to this member". */}
        <FormError error={invite.error} />
        {invite.isSuccess ? (
          <Text style={[styles.success, { color: t.text }]}>
            Invitation sent to {invite.data.displayName}.
          </Text>
        ) : null}
        <Button
          title="Send invitation"
          onPress={() => invite.mutate()}
          loading={invite.isPending}
          disabled={!email.trim()}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { padding: space.md, gap: space.md },
  success: { fontSize: 15 },
});
