// The app's entry point, replacing the default `expo-router/entry`.
//
// When a push wakes the app in the background, the OS starts this JS bundle
// without rendering any screen. A task defined inside a component would not
// exist at that moment, so the background notification task is defined here,
// at module scope, before the router loads.
import './src/push/background-task';
import 'expo-router/entry';
