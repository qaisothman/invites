import { useLocalSearchParams } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useInvitation, useMe, useRespond } from '@/api/queries';
import { longDate, StatusBadge } from '@/invitations/format';
import { Button, ErrorState, FormError, Loading } from '@/ui/components';
import { space, useTheme } from '@/ui/theme';

// Reached from a list row, a tapped push, or a link:
// invites://i/<id> or https://invites.example.com/i/<id>.
export default function InvitationScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Loading it is what tells the server the invitee has seen it.
  const invitation = useInvitation(id);
  const me = useMe();
  const respond = useRespond(id);

  if (invitation.isPending || me.isPending) return <Loading />;
  if (invitation.isError) {
    return (
      <ErrorState error={invitation.error} onRetry={() => void invitation.refetch()} />
    );
  }
  if (me.isError) {
    return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  }

  const inv = invitation.data;
  const isInvitee = me.data?.id === inv.invitee.id;
  const isInviter = me.data?.id === inv.inviter.id;
  const pending = inv.status === 'pending';
  const busy = (action: 'accept' | 'decline' | 'cancel') =>
    respond.isPending && respond.variables === action;

  // Declining and cancelling can't be undone, so ask first.
  function confirm(action: 'decline' | 'cancel', label: string) {
    Alert.alert(`${label}?`, "This can't be undone.", [
      { text: 'Back', style: 'cancel' },
      { text: label, style: 'destructive', onPress: () => respond.mutate(action) },
    ]);
  }

  return (
    <ScrollView
      style={{ backgroundColor: t.background }}
      contentContainerStyle={styles.content}
      // The header is translucent on iOS 26, so the content has to start
      // below it and scroll under it.
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text style={[styles.heading, { color: t.text }]}>
        {isInviter
          ? `You invited ${inv.invitee.displayName}`
          : `${inv.inviter.displayName} invited you`}
      </Text>
      <View style={styles.badgeRow}>
        <StatusBadge status={inv.status} />
      </View>
      {inv.message ? (
        <Text style={[styles.message, { color: t.text, backgroundColor: t.surface }]}>
          {inv.message}
        </Text>
      ) : null}

      <View style={styles.meta}>
        <Meta label="Sent" value={longDate(inv.createdAt)} />
        {pending ? <Meta label="Expires" value={longDate(inv.expiresAt)} /> : null}
        {/* The inviter can see whether it has been looked at yet. */}
        {isInviter && pending ? (
          <Meta label="Seen" value={inv.openedAt ? longDate(inv.openedAt) : 'Not yet'} />
        ) : null}
        {inv.respondedAt ? (
          <Meta label="Answered" value={longDate(inv.respondedAt)} />
        ) : null}
      </View>

      <FormError error={respond.error} />

      {pending && isInvitee ? (
        <View style={styles.actions}>
          <Button
            title="Accept"
            onPress={() => respond.mutate('accept')}
            loading={busy('accept')}
            disabled={respond.isPending}
          />
          <Button
            title="Decline"
            variant="secondary"
            onPress={() => confirm('decline', 'Decline')}
            loading={busy('decline')}
            disabled={respond.isPending}
          />
        </View>
      ) : null}
      {pending && isInviter ? (
        <Button
          title="Cancel invitation"
          variant="secondary"
          onPress={() => confirm('cancel', 'Cancel invitation')}
          loading={busy('cancel')}
          disabled={respond.isPending}
        />
      ) : null}
    </ScrollView>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={styles.metaRow}>
      <Text style={[styles.metaLabel, { color: t.muted }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: t.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.md, gap: space.md, alignItems: 'stretch' },
  heading: { fontSize: 24, fontWeight: '700' },
  badgeRow: { flexDirection: 'row' },
  message: { fontSize: 17, lineHeight: 24, padding: space.md, borderRadius: 12, overflow: 'hidden' },
  meta: { gap: space.sm },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  metaLabel: { fontSize: 15 },
  metaValue: { fontSize: 15, flexShrink: 1, textAlign: 'right' },
  actions: { gap: space.sm },
});
