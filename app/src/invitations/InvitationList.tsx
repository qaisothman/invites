import { router } from 'expo-router';
import { useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useInvitations } from '@/api/queries';
import type { Box, Invitation } from '@/api/types';
import { Empty, ErrorState, Loading } from '@/ui/components';
import { space, useTheme } from '@/ui/theme';

import { StatusBadge, shortDate } from './format';

/** The Received and Sent tabs: pull to refresh, loads more on scroll. */
export function InvitationList({
  box,
  emptyText,
  header,
}: {
  box: Box;
  emptyText: string;
  header?: ReactElement;
}) {
  const t = useTheme();
  const query = useInvitations(box);
  // Our own flag rather than query.isRefetching, which is also true for
  // background refetches; the spinner should only answer the user's pull.
  const [pulling, setPulling] = useState(false);

  if (query.isPending) return <Loading />;
  if (query.isError && !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const items = query.data.pages.flatMap((page) => page.items);

  async function onRefresh() {
    setPulling(true);
    try {
      await query.refetch();
    } finally {
      setPulling(false);
    }
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <Row invitation={item} box={box} />}
      ItemSeparatorComponent={() => (
        <View style={[styles.separator, { backgroundColor: t.border }]} />
      )}
      ListHeaderComponent={header}
      ListEmptyComponent={<Empty text={emptyText} />}
      // Lets the empty state centre itself in the remaining space.
      contentContainerStyle={items.length === 0 && styles.grow}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={onRefresh} />}
      onEndReachedThreshold={0.5}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) {
          void query.fetchNextPage();
        }
      }}
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator style={styles.footer} />
        ) : query.isFetchNextPageError ? (
          <Text style={[styles.footer, styles.footerText, { color: t.muted }]}>
            Couldn't load more. Pull to refresh.
          </Text>
        ) : undefined
      }
    />
  );
}

function Row({ invitation, box }: { invitation: Invitation; box: Box }) {
  const t = useTheme();
  const other = box === 'received' ? invitation.inviter : invitation.invitee;
  // An invitation the user hasn't looked at yet, like an unread email.
  const unseen = box === 'received' && !invitation.openedAt;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/i/${invitation.id}`)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: t.surface }]}
    >
      <View style={styles.rowTop}>
        <Text
          numberOfLines={1}
          style={[styles.name, { color: t.text }, unseen && styles.unseen]}
        >
          {box === 'received' ? 'From ' : 'To '}
          {other.displayName}
        </Text>
        <Text style={[styles.date, { color: t.muted }]}>
          {shortDate(invitation.createdAt)}
        </Text>
      </View>
      <View style={styles.rowBottom}>
        <Text numberOfLines={1} style={[styles.message, { color: t.muted }]}>
          {invitation.message ?? 'No message'}
        </Text>
        <StatusBadge status={invitation.status} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grow: { flexGrow: 1 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: space.md },
  row: { paddingHorizontal: space.md, paddingVertical: 12, gap: space.xs },
  rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { flex: 1, fontSize: 17, fontWeight: '500' },
  unseen: { fontWeight: '700' },
  date: { fontSize: 15 },
  message: { flex: 1, fontSize: 15 },
  footer: { margin: space.md },
  footerText: { textAlign: 'center' },
});
