This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## This project

- iOS only. Shipped as an **unsigned IPA built on GitHub Actions** (`.github/workflows/ios-ipa.yml`) and installed and updated with **AltStore** (Classic) from the repo's own AltStore source, using a free Apple ID. It does **not** run in Expo Go: it needs the local native module `modules/tv-socket`.
- There is a **single release build** and no dev client. **Every merge into `main` ships**: `.github/workflows/ios-ipa.yml` builds the IPA and publishes a GitHub Release plus an AltStore source (`tools/make-altstore-source.mjs`). AltStore then offers the update.
- `main` is protected (ruleset "Protect main"): **never push to `main` and never merge PRs.** Push to a `claude/<topic>` branch and open a PR. The required `checks` workflow must pass; the owner reviews and merges.
- Versions come from CI (`APP_VERSION=1.2.<run>`, `APP_BUILD=<run>` in `app.config.ts`); don't hand-edit them.
- Add packages with `npx expo install`. Keep native code limited to `modules/`.
- Single screen (`App.tsx`). Expo Router is intentionally not used.
- TV protocol logic lives in `src/tv/` as plain TypeScript; sockets are injected via `SocketFactory` (`src/tv/socket.ts`).
- Verify with `npm run typecheck` and `npm test` (end-to-end against a fake self-signed TV; `ws` stands in for the native socket). Swift is compiled only in CI.
