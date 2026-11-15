// Every kind of notification the product sends, in one place.
export const NotificationType = {
  InvitationReceived: 'invitation.received',
  InvitationAccepted: 'invitation.accepted',
} as const;

export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];
