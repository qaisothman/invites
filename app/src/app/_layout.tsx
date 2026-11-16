import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { queryClient } from '@/api/queries';
import { session, useSessionStatus } from '@/auth/session';

// A deep link straight to /i/<id> still gets the tabs underneath it, so Back
// goes somewhere sensible.
export const unstable_settings = { anchor: '(tabs)' };

// Keep the splash screen up until we know whether someone is signed in, so a
// signed-in user never sees the sign-in screen flash past.
void SplashScreen.preventAutoHideAsync();
void session.load();

export default function RootLayout() {
  const status = useSessionStatus();
  const scheme = useColorScheme();
  const signedIn = status === 'signedIn';

  useEffect(() => {
    if (status === 'loading') return;
    SplashScreen.hide();
    // Whoever signs in next must not see the previous user's cached data.
    if (status === 'signedOut') queryClient.clear();
  }, [status]);

  if (status === 'loading') return null;

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        <StatusBar style="auto" />
        {/* Protected groups swap screens when the session changes: signing
            out from anywhere (or a rejected refresh) lands on sign-in. */}
        <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="i/[id]" options={{ title: 'Invitation' }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          </Stack.Protected>
        </Stack>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
