import {
  focusManager,
  type InfiniteData,
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
} from '@tanstack/react-query';
import { AppState } from 'react-native';

import { api, ApiError } from '@/api';
import type { Box, Invitation, Page } from '@/api/types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // A 4xx won't change on retry (not found, forbidden...); only retry
      // network errors and 5xx.
      retry: (failures, error) =>
        failures < 2 &&
        !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    },
  },
});

// React Native has no browser "window focus" event. Tell TanStack Query when
// the app returns to the foreground, so stale lists refetch then.
focusManager.setEventListener((setFocused) => {
  const sub = AppState.addEventListener('change', (state) =>
    setFocused(state === 'active'),
  );
  return () => sub.remove();
});

export const keys = {
  me: ['me'] as const,
  invitations: ['invitations'] as const,
  box: (box: Box) => ['invitations', box] as const,
  invitation: (id: string) => ['invitation', id] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: api.me });
}

/** Received or sent invitations, newest first, one page per cursor. */
export function useInvitations(box: Box) {
  return useInfiniteQuery({
    queryKey: keys.box(box),
    queryFn: ({ pageParam }) => api.listInvitations(box, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useInvitation(id: string) {
  return useQuery({
    queryKey: keys.invitation(id),
    queryFn: async () => {
      const invitation = await api.getInvitation(id);
      // Viewing it marked it opened on the server: update its list row too.
      queryClient.setQueriesData<InfiniteData<Page<Invitation>>>(
        { queryKey: keys.invitations },
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.map((item) => (item.id === id ? invitation : item)),
            })),
          },
      );
      return invitation;
    },
  });
}

/** Accept, decline (invitee) or cancel (inviter). */
export function useRespond(id: string) {
  return useMutation({
    mutationFn: (action: 'accept' | 'decline' | 'cancel') =>
      api.respond(id, action),
    onSuccess: (invitation) => {
      queryClient.setQueryData(keys.invitation(id), invitation);
      void queryClient.invalidateQueries({ queryKey: keys.invitations });
    },
    // 409/410 mean someone else got there first (the inviter cancelled, it
    // expired): reload so the screen shows the real status.
    onError: () =>
      queryClient.invalidateQueries({ queryKey: keys.invitation(id) }),
  });
}
