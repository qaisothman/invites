import type { ExpoConfig } from 'expo/config';

// TypeScript instead of app.json so the deep-link and push settings can carry
// comments. `expo prebuild` / `expo run:*` turn this into the native projects;
// ios/ and android/ are generated and not committed.

const LINK_HOST = 'invites.example.com';

// A physical iPhone needs a bundle id registered on your Apple team, and push
// needs a paid team. Both come from .env so the repo doesn't name an account;
// the placeholder works on the Simulator and an emulator.
const APP_ID = process.env.APP_ID || 'com.example.invites';
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || undefined;

const config: ExpoConfig = {
  name: 'Invites',
  slug: 'invites',
  version: '1.0.0',
  platforms: ['ios', 'android'],
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  // invites://i/<id> opens the invitation screen (expo-router maps the path).
  scheme: 'invites',
  userInterfaceStyle: 'automatic',
  // newArchEnabled is left at the default: the New Architecture is the only
  // one React Native 0.88 ships.
  ios: {
    bundleIdentifier: APP_ID,
    // Written into the Xcode project as DEVELOPMENT_TEAM, so the team is set
    // for automatic signing after every prebuild. The first device build
    // still runs from the Xcode app.
    appleTeamId: APPLE_TEAM_ID,
    icon: './assets/expo.icon',
    // Universal links: https://invites.example.com/i/<id> (the `url` in every
    // push) opens the app instead of Safari. In production this needs the real
    // domain here and an apple-app-site-association file served from it.
    associatedDomains: [`applinks:${LINK_HOST}`],
    infoPlist: {
      // iOS asks before an app talks to the local network. Only a phone
      // testing against the API on your Mac's LAN address sees the prompt;
      // dev-launcher strips its own wording from release builds, so without
      // this a release build on a phone can't reach that API.
      NSLocalNetworkUsageDescription:
        'Invites connects to a development server on your local network.',
    },
  },
  android: {
    package: APP_ID,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    // App links, Android's universal links. autoVerify only succeeds once the
    // real domain serves /.well-known/assetlinks.json with the signing
    // certificate's SHA-256; until then Android asks which app to open.
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: LINK_HOST, pathPrefix: '/i/' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#208AEF',
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
      },
    ],
    'expo-secure-store',
    [
      'expo-notifications',
      {
        // Adds `remote-notification` to UIBackgroundModes, so a push sent
        // with content-available can wake the app and run the background
        // task that acknowledges delivery (src/push/background-task.ts).
        enableBackgroundRemoteNotifications: true,
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    eas: {
      // The id `eas init` prints; put it in .env as EAS_PROJECT_ID. Expo
      // can't issue push tokens without it, so until it's set the app works
      // normally and skips push registration (src/push/push.ts).
      projectId: process.env.EAS_PROJECT_ID || undefined,
    },
  },
};

export default config;
