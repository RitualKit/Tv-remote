# Frame Remote: native iOS build, sideloaded with Sideloadly

## Context
v1 is built (commit `f720811`, local `claude/frame-remote-v1`). It runs in Expo Go and reaches the user's **2022/23 Frame** through a LAN relay. The relay was only needed because Expo Go can't accept the TV's self-signed `wss://:8002` cert.

The user now wants to **deploy with Sideloadly** instead. Their setup:
- **Windows PC**
- **free Apple ID**
- **iPhone**

They also asked to **remove the relay** and **delete the pushed branch**. There is no PR; only the branch was pushed.

A sideloaded app is a real native build. That lets us add a tiny Swift module that accepts the TV's certificate. The result: the phone talks to the TV directly on 8002, and no other device is needed.

**Outcome:** an IPA built in the cloud (no Mac), sideloaded from Windows. It pairs with the Frame directly and keeps working while the PC is off. A 7-day refresh routine is needed because of the free Apple ID.

---

## 1. Research findings

**Sideloadly + free Apple ID**
- Apps stop launching after **7 days**; re-sign with the same Apple ID to renew.
- At most **3 sideloaded apps** at once, and about **10 new App IDs per week**. Reusing a bundle ID doesn't consume a new one.
- Re-installing the same bundle ID is an update, so app data (pairing token, settings) is kept.
- iOS 16+ needs **Developer Mode**: Settings → Privacy & Security → Developer Mode, then restart. After the first install, trust the profile under Settings → General → VPN & Device Management.
- Sideloadly advertises **auto-refresh** for re-signing. Sources disagree on how hands-off it is: the PC probably must be on with Sideloadly running and the phone on the same Wi-Fi. sideloadly.io is unreachable from this sandbox, so verify locally. The fallback is a 1-minute USB re-sideload weekly.
- Sideloadly re-signs whatever IPA it gets, so an **unsigned IPA** is fine.
- Free accounts can't get restricted entitlements.

**Building an IPA without a Mac**
- GitHub Actions macOS runner: `npx expo prebuild -p ios` → `pod install` → `xcodebuild -configuration Release -sdk iphoneos CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build` → copy `*.app` into `Payload/` → `zip -r App.ipa Payload`. This is the pattern used by SergioDPal/ipa-builder and similar Expo guides.
- EAS Build isn't usable: device builds need signing credentials, which a free Apple ID can't provide.
- SDK 58 requires **Node ≥ 22.13** (checked in `node_modules/expo/package.json`). Community workflows pin Node 20, which would break.
- The repo is **private**. GitHub Free gives 2,000 Actions minutes a month and macOS counts 10×, so there are about 200 macOS minutes. That's roughly **8 builds a month**; CocoaPods caching helps. Making the repo public would make it free (user's choice; not assumed).

**Native TLS socket**
- RN's built-in WebSocket exposes no trust override.
- `react-native-websocket-self-signed` (0.5.0, Jan 2026) exists, but its New-Architecture support is unclear.
- **Recommend a ~150-line local Expo module** (`modules/tv-socket`) built on `URLSessionWebSocketTask`. A session delegate handles `NSURLAuthenticationMethodServerTrust`.
  - It accepts **only** the host it was asked to open, which must be a private-range IPv4 address.
  - It reports the leaf cert's SHA-256, which JS pins trust-on-first-use, so a different cert later is rejected.
  - Network.framework (`NWProtocolWebSocket` + `sec_protocol_options_set_verify_block`) is the fallback if the delegate route misbehaves.
- Verified locally in SDK 58's `expo-modules-core`:
  - the Swift DSL has `Name`, `Events`, `Function`, `AsyncFunction`, `OnDestroy` and `sendEvent`;
  - JS gets the module via `requireNativeModule`, and it is an `EventEmitter`;
  - autolinking picks up `./modules` by default.

**Still not possible (free account):**
- Wake-on-LAN and SSDP discovery: broadcast/multicast UDP needs Apple's restricted multicast entitlement, which isn't granted to free or development builds.
- So it stays manual IP entry, and no power-on from fully off. Art Mode → TV still works.

**iOS plist:**
- `NSLocalNetworkUsageDescription` (already in `app.json`).
- `NSAppTransportSecurity.NSAllowsLocalNetworking = true`, for `http://<tv>:8001/api/v2/` device info and REST app launch. Expo dev clients rely on the same setting to reach Metro by LAN IP.

## 2. Target architecture
```
iPhone app ──wss://TV:8002 (native TvSocket, TOFU-pinned cert)──▶ The Frame
           ──http://TV:8001/api/v2/ (fetch: info, REST app launch)──▶
```
Changes to the current code:
- **Socket factory.** `SamsungRemote` and `art.ts` take `createSocket(url)`:
  - production: `TvSocket`, a WebSocket-shaped JS wrapper over the native module;
  - tests: Node `ws` with `rejectUnauthorized:false`.
  - The rest of the code is unchanged; `SamsungRemote.ts` keeps its state machine, pairing, backoff and register frame.
- **Simplified config.** `src/tv/protocol.ts`:
  - `TvConfig` becomes `{ tvIp }`;
  - `wsBase` becomes `wss://<ip>:8002`, `httpBase` becomes `http://<ip>:8001`;
  - `mode`, `relayHost` and `normalizeRelayHost` are removed.
  - The token stays in the URL; the 8002 protocol requires it.
- **Settings** (`src/storage.ts`): `{ tvIp, token, certSha256 }`.
- **`SetupModal`:** the transport selector and relay field go. Add "Reset TV certificate", and the debug log shows the pinned fingerprint.
- **Deleted:** `relay/relay.mjs`, `relay/package.json` and `relay/README.md`. `relay/probe.mjs` moves to `tools/probe.mjs` (uses the root `ws` devDependency; `npm run probe -- <ip>`). It still works on Windows and is milestone 0.
- **Variants.** `app.config.ts` takes `APP_VARIANT=dev|release`:
  - bundle IDs `com.ritualkit.frameremote(.dev)`;
  - names "Frame Remote (Dev)" / "Frame Remote".
  - Both can be installed side by side (2 of the 3 free slots).
- **Dev client.** Add `expo-dev-client` with `npx expo install`. A Debug build is a dev client that loads JS from `npx expo start` on the Windows PC over LAN. Release bundles JS and needs no PC.
- **Drop Expo Go support.** `AGENTS.md` "This project" is rewritten:
  - native module allowed, dev-client workflow;
  - `npm test` / `npm run typecheck`;
  - IPA via GitHub Actions.

## 3. New/changed files
```
modules/tv-socket/expo-module.config.json   {"platforms":["apple"],"apple":{"modules":["TvSocketModule"]}}
modules/tv-socket/ios/TvSocketModule.swift  open(id,url,pinnedSha256?) / send(id,text) / close(id);
                                            events onOpen{id,certSha256} onMessage{id,data} onClose{id,code,reason} onError{id,message}
modules/tv-socket/ios/TvSocket.podspec
modules/tv-socket/index.ts                  requireNativeModule('TvSocket') + TvSocket class (onopen/onmessage/onclose/onerror/send/close)
src/tv/socket.ts                            SocketLike type + default factory
src/tv/protocol.ts, SamsungRemote.ts, art.ts, rest.ts, storage.ts, useRemote.ts, ui/SetupModal.tsx, ui/StatusPill.tsx   (simplify)
app.config.ts                               replaces app.json; variants, infoPlist (NSLocalNetworkUsageDescription, NSAllowsLocalNetworking)
.github/workflows/ios-ipa.yml               build unsigned IPA (dev|release) → artifact
tools/probe.mjs                             moved from relay/
test/e2e.mts, test/fake-tv.mjs              direct to fake TV on wss (no relay), + cert-pin and TOFU checks
README.md, docs/PLAN.md, AGENTS.md          Sideloadly workflow, refresh routine, troubleshooting
relay/                                      deleted
```

**Workflow `ios-ipa.yml`:**
- Triggers: `workflow_dispatch` with input `variant: dev|release`, and pushes of tags `v*`.
- `runs-on: macos-latest`, newest Xcode selected and versions printed. `setup-node@v4` with Node 22 and npm cache, then `npm ci`.
- `APP_VARIANT=$variant npx expo prebuild -p ios --clean`, with the Pods cache keyed on `ios/Podfile.lock`.
- `xcodebuild -workspace ios/*.xcworkspace -scheme <name> -configuration Debug|Release -sdk iphoneos -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build`.
- Zip the Payload, then `upload-artifact` (`FrameRemote-<variant>.ipa`, 30-day retention), with `timeout-minutes: 45`.

## 4. Build order (each step has a milestone)
1. **Delete the remote branch** `claude/frame-remote-v1` (as requested); keep the local commit.
   - **M1:** `git ls-remote origin` is empty.
2. **Probe on Windows (no build):** `npm i && npm run probe -- <tv-ip> --art --apps` (moved script).
   - **M2:** the TV shows Allow, volume moves, art status prints. This confirms 8002 pairing works before any iOS work.
3. **Refactor JS:** socket factory, remove relay/mode, simplify settings/UI, rework the tests to go direct to the fake TV on wss, plus TOFU tests.
   - **M3:** `npm run typecheck` and `npm test` pass in this sandbox.
4. **Native module + config:** `modules/tv-socket`, `app.config.ts`, `expo-dev-client`.
   - **M4 (sandbox):** `npx expo prebuild -p ios --no-install` on Linux generates `ios/` with `TvSocket` autolinked and the right Info.plist keys. Swift is compiled first in CI.
5. **CI workflow.** This needs code on GitHub again, so **I'll ask before pushing**. Proposal: push to `main` on the empty repo so the manual-run button appears.
   - **M5:** the Actions run is green and yields `FrameRemote-dev.ipa`.
6. **Sideload the dev build** (Windows: Sideloadly, USB, Apple ID). Turn on Developer Mode and trust the profile. Then run `npx expo start` on the PC and open the URL in the dev client.
   - **M6:** the app pairs with the Frame directly on 8002, and keys work. This is the key native milestone.
7. **Iterate UI/JS** live through the dev client: no rebuilds and no CI minutes.
   - **M7:** features as in v1 (D-pad, vol/ch repeat, power/Art, apps, number pad, reconnect on foreground).
8. **Release build** (`variant: release`) → sideload.
   - **M8:** works with the PC off; reinstalling keeps the pairing.
9. **7-day routine:** enable Sideloadly auto-refresh, or re-sideload the same IPA weekly; document both.
   - **M9:** the app survives past day 7.

## 5. Testing & troubleshooting
- **Sandbox:** `npm run typecheck`, `npm test`. Tests cover pairing, token reuse, the 8001 refusal path, art, REST, reconnect, and cert-pin mismatch rejection; they use `ws` as the socket.
- **Native:** the CI compile, then M6 on the device.
- **Windows needs:** Sideloadly, plus Apple's iTunes and iCloud (non-Store versions are commonly required; verify on sideloadly.io), plus Node 22.
- **Checklist:**
  - Developer Mode on; profile trusted.
  - Local Network prompt → Allow. If missed: Settings → Privacy & Security → Local Network → Frame Remote.
  - Same Wi-Fi, no client isolation or VPN.
  - TV on or in Art Mode, with Allow accepted.
  - Device Connection Manager: "First Time Only"; delete denied entries.
  - "Maximum App ID limit" → wait a week or reuse existing bundle IDs.
  - App won't open after 7 days → re-sideload.
  - Cert-changed error after a TV firmware update → Settings → Reset TV certificate.

## 6. Risks & open items
- The `URLSessionWebSocketTask` trust delegate isn't proven against the Samsung TLS server. If it fails at M6, switch to Network.framework (≈1 extra CI build).
- CI budget is about 8 builds a month; the dev-client flow keeps rebuilds to native changes only.
- Xcode on `macos-latest` vs SDK 58 requirements couldn't be read (expo.dev blocked). The workflow prints versions; pin if needed.
- Sideloadly auto-refresh details are unverified.
- Prime/Disney IDs, the full-off hold and the art API on this firmware are still unverified; M2 and M7 test them.

## Sources
- Sideloadly FAQ / home (limits, Developer Mode, auto-refresh): https://sideloadly.io/faq.html, https://sideloadly.io/index.html
- Free-account App ID / refresh comparisons: https://builds.io/blog/technologies/ios-technologies/sideloadly-vs-altstore-vs-sidestore/, https://howmobile.net/ios/ios-sideloading-guide
- Unsigned IPA on GitHub Actions: https://github.com/SergioDPal/ipa-builder, https://dev.to/oivoodoo/build-unsigned-ios-ipa-to-install-via-sideloadly-236f, https://github.com/facebook/react-native/issues/34673
- Self-signed trust via URLSession delegate: https://developer.apple.com/forums/thread/666986, https://mas.owasp.org/MASTG/tests/ios/MASVS-NETWORK/MASTG-TEST-0396/
- Multicast entitlement restrictions: https://developer.apple.com/forums/thread/705550, https://developer.apple.com/forums/thread/657887
- Self-signed WS library option: https://socket.dev/npm/package/react-native-websocket-self-signed
- Samsung protocol and 2022 Frame 8002 requirement (from v1 research): https://github.com/xchwarze/samsung-tv-ws-api, https://github.com/xchwarze/samsung-tv-ws-api/issues/108
