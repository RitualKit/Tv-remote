import type { ExpoConfig } from 'expo/config';

// Single release build: JS is bundled into the app, installed and refreshed with AltStore.
//
// CI sets APP_VERSION=1.2.<run> and APP_BUILD=<run> so every release is strictly newer; AltStore
// compares the source's newest version/buildVersion with the installed CFBundleShortVersionString
// / CFBundleVersion to offer updates.
const version = process.env.APP_VERSION || '1.2.0';
const buildNumber = process.env.APP_BUILD || '1';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`APP_VERSION must look like 1.2.3, got "${version}"`);
if (!/^\d+$/.test(buildNumber)) throw new Error(`APP_BUILD must be a whole number, got "${buildNumber}"`);

const config: ExpoConfig = {
  name: 'Frame Remote',
  slug: 'frame-remote',
  version,
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  platforms: ['ios'],
  ios: {
    bundleIdentifier: 'com.ritualkit.frameremote',
    buildNumber,
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
