import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import type { TokenStore, Tokens } from '@/api/client';

// The session: who is signed in, as far as this phone knows.
//
// - The refresh token (30 days) is the long-lived secret, so it lives in the
//   Keychain / Android Keystore via expo-secure-store.
// - The access token (15 minutes) only lives in memory. After a restart the
//   API client trades the refresh token for a new one on the first request.
//
// A module-level store rather than React context: the API client, which is
// not a component, must be able to end the session when a refresh is
// rejected. Screens subscribe with useSessionStatus().

const REFRESH_TOKEN_KEY = 'refreshToken';
// AFTER_FIRST_UNLOCK instead of the default WHEN_UNLOCKED: the background
// notification task may need the token while the phone is locked.
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export type SessionStatus = 'loading' | 'signedIn' | 'signedOut';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let status: SessionStatus = 'loading';
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setStatus(next: SessionStatus) {
  if (next === status) return;
  status = next;
  listeners.forEach((listener) => listener());
}

export const session: TokenStore & {
  load(): Promise<void>;
  getStatus(): SessionStatus;
  subscribe(listener: () => void): () => void;
} = {
  /** Reads the stored refresh token once per JS runtime. Safe to call often. */
  load() {
    loaded ??= SecureStore.getItemAsync(REFRESH_TOKEN_KEY, KEYCHAIN).then(
      (token) => {
        refreshToken = token;
        setStatus(token ? 'signedIn' : 'signedOut');
      },
      () => setStatus('signedOut'),
    );
    return loaded;
  },

  getAccessToken: () => accessToken,
  getRefreshToken: () => refreshToken,

  async save(tokens: Tokens) {
    // Memory first, so a request starting now already uses the new tokens.
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    await SecureStore.setItemAsync(
      REFRESH_TOKEN_KEY,
      tokens.refreshToken,
      KEYCHAIN,
    );
    setStatus('signedIn');
  },

  async clear() {
    accessToken = null;
    refreshToken = null;
    // Signed out even if the Keychain delete fails, as load() is on a failed read.
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, KEYCHAIN).catch(
      () => undefined,
    );
    setStatus('signedOut');
  },

  getStatus: () => status,

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Re-renders the caller when the user signs in or out. */
export function useSessionStatus(): SessionStatus {
  return useSyncExternalStore(session.subscribe, session.getStatus);
}
