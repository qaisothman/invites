import { session } from '@/auth/session';

import { createApiClient } from './client';
import type {
  AuthResponse,
  Box,
  Device,
  Invitation,
  Me,
  NotificationsState,
  Page,
  PublicUser,
} from './types';

export { ApiError } from './client';

// EXPO_PUBLIC_ variables are inlined into the bundle at build time, so this
// is not a secret and changing it needs a Metro restart.
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3100';

const { request, publicRequest } = createApiClient({
  baseUrl: API_URL,
  tokens: session,
});

function query(params: Record<string, string | undefined>) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

// One typed function per endpoint the app uses. Screens call these through
// TanStack Query (src/api/queries.ts), never fetch directly.
export const api = {
  register: (input: { email: string; password: string; displayName: string }) =>
    publicRequest<AuthResponse>('POST', '/auth/register', input),
  login: (input: { email: string; password: string }) =>
    publicRequest<AuthResponse>('POST', '/auth/login', input),
  logout: (refreshToken: string) =>
    publicRequest<void>('POST', '/auth/logout', { refreshToken }),

  me: () => request<Me>('GET', '/users/me'),
  updateMe: (patch: { displayName?: string; invitationEmails?: boolean }) =>
    request<Me>('PATCH', '/users/me', patch),
  lookupUser: (email: string) =>
    request<PublicUser>('GET', `/users/lookup${query({ email })}`),

  listInvitations: (box: Box, cursor?: string) =>
    request<Page<Invitation>>('GET', `/invitations${query({ box, cursor })}`),
  // Also marks it opened when the invitee views it.
  getInvitation: (id: string) =>
    request<Invitation>('GET', `/invitations/${id}`),
  createInvitation: (input: { inviteeId: string; message?: string }) =>
    request<Invitation>('POST', '/invitations', input),
  respond: (id: string, action: 'accept' | 'decline' | 'cancel') =>
    request<Invitation>('POST', `/invitations/${id}/${action}`),

  registerDevice: (input: {
    expoPushToken: string;
    platform: 'ios' | 'android';
    appVersion?: string;
    notifications: NotificationsState;
  }) => request<Device>('POST', '/devices', input),
  unregisterDevice: (id: string) => request<void>('DELETE', `/devices/${id}`),

  // Delivery receipts for pushes. See src/push for when each is sent.
  notificationDelivered: (id: string) =>
    request<void>('POST', `/notifications/${id}/delivered`),
  notificationOpened: (id: string) =>
    request<void>('POST', `/notifications/${id}/opened`),
};
