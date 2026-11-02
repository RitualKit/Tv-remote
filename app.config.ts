import type { ExpoConfig } from 'expo/config';

// Two installable variants, so the dev client and the everyday app can sit side by side
// (2 of the 3 apps a free Apple ID may have sideloaded):
//   APP_VARIANT=dev      → "Frame Remote (Dev)", loads JS from `npx expo start` on your PC
//   APP_VARIANT=release  → "Frame Remote", JS bundled in, works with the PC off (default)
const isDev = process.env.APP_VARIANT === 'dev';

const config: ExpoConfig = {
  name: isDev ? 'Frame Remote (Dev)' : 'Frame Remote',
  slug: 'frame-remote',
  version: '1.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'dark',
  platforms: ['ios'],
  // Registers the exp+frame-remote:// scheme so the Camera can open the dev build from the
  // `npx expo start` QR code. Inert in release builds.
  plugins: ['expo-dev-client'],
  ios: {
    bundleIdentifier: isDev ? 'com.ritualkit.frameremote.dev' : 'com.ritualkit.frameremote',
    buildNumber: '2',
    supportsTablet: false,
    infoPlist: {
      // Shown in the iOS prompt the first time the app talks to the TV.
      NSLocalNetworkUsageDescription: 'Frame Remote connects to your Samsung TV on your Wi-Fi network.',
      // Personal, sideloaded app that only talks to the TV on the LAN (http://<ip>:8001 for info
      // and app launch, plus Metro for the dev build). NSAllowsLocalNetworking is deliberately
      // not set: iOS ignores NSAllowsArbitraryLoads whenever it is present.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
    },
  },
};

export default config;
