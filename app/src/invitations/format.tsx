import { StyleSheet, Text } from 'react-native';

import type { InvitationStatus } from '@/api/types';
import { useTheme } from '@/ui/theme';

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

export function longDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const LABEL: Record<InvitationStatus, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

/** Pending is the only state that needs action, so only it gets the accent. */
export function StatusBadge({ status }: { status: InvitationStatus }) {
  const t = useTheme();
  const color = status === 'pending' ? t.accent : t.muted;
  return (
    <Text style={[styles.badge, { color, borderColor: color }]}>{LABEL[status]}</Text>
  );
}

const styles = StyleSheet.create({
  badge: {
    fontSize: 13,
    fontWeight: '600',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});
