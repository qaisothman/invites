import { api } from '@/api';
import { keys, queryClient } from '@/api/queries';
import type { AuthResponse } from '@/api/types';
import { unregisterDevice } from '@/push/push';

import { session } from './session';

// Sign in, register, sign out. The root layout watches the session status
// and swaps between the sign-in screen and the tabs.

async function start(res: AuthResponse) {
  // Seed the profile so the tabs don't flash a spinner for data we have.
  queryClient.setQueryData(keys.me, res.user);
  await session.save(res);
}

export async function signIn(email: string, password: string) {
  await start(await api.login({ email: email.trim(), password }));
}

export async function register(input: {
  email: string;
  password: string;
  displayName: string;
}) {
  await start(
    await api.register({
      ...input,
      email: input.email.trim(),
      displayName: input.displayName.trim(),
    }),
  );
}

/**
 * Best effort, in this order: stop pushes to this phone (needs a valid
 * access token), revoke the refresh token on the server, then forget the
 * session locally. The local part always happens, even offline.
 */
export async function signOut() {
  const refreshToken = session.getRefreshToken();
  await unregisterDevice().catch(() => undefined);
  if (refreshToken) await api.logout(refreshToken).catch(() => undefined);
  await session.clear();
}
