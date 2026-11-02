# Frame Remote: AltStore, release build only

## Context
Commit `feae7c6` (local, not pushed) already has:
- a native iOS build with the `modules/tv-socket` Swift socket (direct `wss://TV:8002`, cert pinned on first use);
- a GitHub Actions workflow that builds an unsigned `.ipa`;
- docs written for **Sideloadly**, plus two variants (dev client + release).

The user has now decided:
1. **AltStore (Classic)** instead of Sideloadly, from a Windows PC with a free Apple ID.
2. **Release build only.** No dev-client variant.
3. **Push to `main`** once done. Afterwards the user makes `main` the default branch on GitHub and deletes the old `claude/frame-remote-v1` there; this session's git proxy blocked the delete with a 403.
4. **Delete the untracked `LICENSE`.** It is Expo's template license.

Outcome: one app, "Frame Remote", installed and refreshed with AltStore. The build pipeline stays; the dev-client machinery and the Sideloadly docs go.

## Research findings (AltStore Classic, Windows, free Apple ID)
AltStore's own site, faq.altstore.io, is blocked from this sandbox. The points below come from search summaries of that FAQ plus third-party guides; anything marked *(verify)* is unconfirmed.

**Windows setup**
- Install **iTunes and iCloud from Apple's website, not the Microsoft Store.** Uninstall the Store versions first.
- Run AltServer as administrator and allow it through the firewall on private networks.
- Sign in to iTunes, then use the AltServer tray icon → **Install AltStore** → pick the iPhone → enter the Apple ID.
- iPhone: turn on Developer Mode (iOS 16+), then trust the Apple ID under Settings → General → VPN & Device Management.

**Installing our app**
- Get the `.ipa` into the iPhone's **Files** app. iCloud for Windows is already installed, so dropping it into iCloud Drive works; downloading it in Safari also works.
- Then AltStore → **My Apps → "+"** → pick the `.ipa`.
- Re-installing the same app is an in-place update, so data is kept *(verify)*.

**Limits**
- **3 active sideloaded apps, and AltStore counts as one.** AltStore + Frame Remote = 2 of 3.
- About **10 App IDs per 7 days**.
- Apps expire after **7 days**.

**Refresh**
- AltStore refreshes in the background when AltServer is running on a PC on the **same Wi-Fi**. iTunes "Sync with this iPhone over Wi-Fi" should be on.
- USB refresh is the fallback.
- App data survives expiry and refresh.

**Effects on this project**
- The unsigned IPA is fine: AltStore re-signs at install.
- The app has no extensions or entitlements, so it uses only 1 App ID.
- AltStore may rewrite the bundle ID for free accounts *(verify)*. Harmless here: storage is per-install and nothing depends on the ID.

**Release-only trade-off**
- With no dev client, **every change to code on the phone needs a CI build plus an AltStore reinstall**: about 20 macOS minutes, against a budget of roughly 8 builds a month on this private repo.
- Mitigations:
  - `npm test` plus a typecheck gate before every macOS run (already in place);
  - `npm run probe` to check TV behaviour from the PC without a build;
  - batch changes into fewer builds.

## Changes
- **`app.config.ts`**:
  - remove `APP_VARIANT`;
  - set `name: 'Frame Remote'` and `bundleIdentifier: 'com.ritualkit.frameremote'`;
  - remove `plugins: ['expo-dev-client']`;
  - update the ATS comment (no Metro anymore).
- **Dependencies:** remove `expo-dev-client` with `npm uninstall expo-dev-client`. That's the counterpart of `npx expo install`; there's no `expo uninstall`. Confirm `package.json` and the lockfile are clean.
- **`.github/workflows/ios-ipa.yml`**:
  - drop the `variant` input and the `EX_DEV_CLIENT_NETWORK_INSPECTOR` env;
  - always build Release, and keep the `main.jsbundle` assertion;
  - artifact `FrameRemote-ipa` containing `FrameRemote.ipa`;
  - triggers: `workflow_dispatch` and tags `v*`;
  - header comment mentions AltStore.
- **`modules/tv-socket/ios/TvSocketModule.swift`:** reword the `.ephemeral` comment (no dev-client inspector). No functional change.
- **`README.md`:** replace the Sideloadly sections with AltStore:
  - one-time setup (iTunes and iCloud from Apple, AltServer as admin plus firewall, Install AltStore, Developer Mode, trust profile, Wi-Fi sync);
  - build → download artifact → iCloud Drive / Files → AltStore "+";
  - refresh and limits (AltStore + app = 2 of 3, 10 IDs/week, 7 days);
  - an update flow and a troubleshooting section.
  - Remove the dev-build section, and add a short "making changes" note about the per-change build cost.
- **`AGENTS.md`** "This project": AltStore, release only, no dev client; changes reach the phone only via a CI build.
- **`docs/PLAN.md`:** replace with this plan.
- **`LICENSE`:** delete (untracked; user-approved).

## Steps
1. Apply the changes above.
2. Verify locally:
   - `npx tsc --noEmit` and `npm test` pass;
   - `npx expo config` shows the single variant;
   - a Linux `expo prebuild -p ios --no-install` in a scratch copy yields one target `FrameRemote`, with the Local Network text and the ATS dict, and no `exp+` URL scheme;
   - `expo export -p ios` bundles.
3. Commit (`LICENSE` gone, tree clean).
4. **Push to `main`**: `git push -u origin HEAD:main`, then track `main` locally.
5. Hand off to the user:
   - GitHub → Settings → default branch `main`, then delete `claude/frame-remote-v1`;
   - Actions → "iOS IPA" → Run workflow. The first run is the first Swift compile; if it fails, the uploaded `xcodebuild-log` shows why;
   - install with AltStore per the README.

## Verification
- **Sandbox:** typecheck, 9 checks passing in `npm test`, prebuild output inspected, iOS bundle exported.
- **CI** (after push, run by the user): the checks job and the macOS job are green, and the `FrameRemote.ipa` artifact exists.
- **Device:**
  - AltStore installs the app;
  - the Local Network prompt appears;
  - Allow on the TV leads to Connected, and keys work;
  - after an AltStore refresh, the app opens and stays paired.

## Sources
- AltStore Windows install and troubleshooting: https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows, https://faq.altstore.io/altstore-classic/troubleshooting-guide
- Installing an IPA via My Apps "+" and the 3-app limit: https://ipagame.store/guides/install-ipa-with-altstore/, https://rottenwifi.com/how-to-sideload-apps-on-an-iphone-with-altstore-classic/
- Refresh / expiry behaviour: https://en.wikipedia.org/wiki/AltStore, https://theapplewiki.com/wiki/AltStore
- 2026 comparisons: https://builds.io/blog/technologies/ios-technologies/altstore-vs-sidestore-vs-livecontainer/
- Unsigned IPA on GitHub Actions: https://github.com/SergioDPal/ipa-builder
- Samsung protocol / 2022 Frame requires 8002: https://github.com/xchwarze/samsung-tv-ws-api/issues/108

## Addendum: Wi-Fi discovery (subnet scan)
- **Why:** SSDP/UPnP needs multicast, which a free account can't get the iOS entitlement for. A plain unicast scan needs only the Local Network permission the app already asks for.
- **How:**
  - `expo-network` `getIpAddressAsync()` gives the Wi-Fi IPv4 (`en*` interface; `0.0.0.0` if none).
  - Probe x.y.z.1–254 except the phone itself, with `GET http://<ip>:8001/api/v2/` at 900 ms timeout, 32 in parallel.
  - Accept only replies with a `device` object.
  - List results with Frames first.
  - First launch (no saved IP) scans automatically; exactly one result is pre-filled. Closing the sheet cancels the scan.
- **Files:** `src/tv/discovery.ts` (pure), `src/useTvScan.ts`, `src/ui/SetupModal.tsx`, `src/tv/rest.ts` (`getDeviceInfo` timeout + device check).
- **Limits:** /24 only. The first scan may miss everything while iOS is still showing the Local Network prompt; the UI says to scan again.
- **Tests (`npm test`):**
  - subnet candidates;
  - concurrency cap, progress, sort and cancel;
  - probe against the fake TV, a non-TV JSON server, a closed port and a silent host.
