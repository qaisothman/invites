// Every kind of notification the product sends, in one place.
export const NotificationType = {
  InvitationReceived: 'invitation.received',
  InvitationAccepted: 'invitation.accepted',
} as const;

export type NotificationType =
  (typeof NotificationType)[keyof typeof NotificationType];

// Emailed when no phone of the invitee's can show the push: they may not open
// the app otherwise, and this is the step the growth funnel depends on. "Your
// invite was accepted" stays push-only; the inviter will see it in the app.
export const EMAIL_TYPES: string[] = [NotificationType.InvitationReceived];
