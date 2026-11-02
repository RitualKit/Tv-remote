import type { ExpoConfig } from 'expo/config';

// Single release build: JS is bundled into the app, installed and refreshed with AltStore.
const config: ExpoConfig = {
  name: 'Frame Remote',
  slug: 'frame-remote',
  version: '1.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  platforms: ['ios'],
  ios: {
    bundleIdentifier: 'com.ritualkit.frameremote',
    buildNumber: '2',
    supportsTablet: false,
    infoPlist: {
      // Shown in the iOS prompt the first time the app talks to the TV.
      NSLocalNetworkUsageDescription: 'Frame Remote connects to your Samsung TV on your Wi-Fi network.',
      // Personal, sideloaded app that only talks to the TV on the LAN (plain http://<ip>:8001 for
      // device info and app launch). NSAllowsLocalNetworking is deliberately not set: iOS ignores
      // NSAllowsArbitraryLoads whenever it is present.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
    },
  },
};

export default config;
