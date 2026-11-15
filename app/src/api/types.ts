// Response and request shapes, copied by hand from api/src (the source of
// truth). Dates arrive as ISO strings because they travel as JSON.

export interface Me {
  id: string;
  email: string;
  displayName: string;
  /** Email about invitations when no phone of theirs can show them. */
  invitationEmails: boolean;
  role: 'member' | 'admin';
  createdAt: string;
}

export interface PublicUser {
  id: string;
  displayName: string;
}

export interface AuthResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  user: Me;
}

export type InvitationStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'expired';

export interface Invitation {
  id: string;
  status: InvitationStatus;
  message: string | null;
  inviter: PublicUser;
  invitee: PublicUser;
  expiresAt: string;
  openedAt: string | null;
  respondedAt: string | null;
  createdAt: string;
}

export type Box = 'received' | 'sent';

// Keyset pagination: pass nextCursor back to get the following page.
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Whether a phone can show our pushes (see src/push/push.ts). */
export type NotificationsState = 'allowed' | 'off' | 'not_asked';

export interface Device {
  id: string;
  platform: 'ios' | 'android';
  notifications: NotificationsState;
}

// The `data` the server puts on every push (see api/src/notifications).
export interface PushData {
  notificationId: string;
  /** Signed for this notification; confirms delivery without a session. */
  ackToken?: string;
  type: 'invitation.received' | 'invitation.accepted';
  invitationId: string;
  url: string;
}
