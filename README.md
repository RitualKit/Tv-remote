# Frame Remote

An iPhone remote for a Samsung **The Frame** (2022+). It's an Expo / React Native app, built in
the cloud as an unsigned `.ipa` and installed with **AltStore** from a Windows PC. No Mac and no
paid Apple account are needed.

It has:
- D-pad, Back, Home, Menu, Source, Info, Guide
- volume and channel, with repeat-while-held
- mute and Power (tap toggles Art↔TV, hold turns the TV off), plus an Art/TV button
- a collapsible number pad and Netflix / YouTube / Prime / Disney+ shortcuts
- haptics, a connection status pill and auto-reconnect

Research and design decisions are in [docs/PLAN.md](docs/PLAN.md).

## How it connects

```
iPhone ──wss://<tv-ip>:8002 (native TvSocket)──▶ The Frame     remote keys, Art Mode
       ──http://<tv-ip>:8001/api/v2/──────────▶               device info, app launch
```

2022+ Frames only accept remote control on port 8002, with a self-signed certificate.
`modules/tv-socket` is a small Swift module that accepts that certificate, with three limits:
- only for `wss://` to a private LAN IPv4 address;
- only for the host being opened;
- only if the certificate matches the one pinned on first connect.

That's why this app needs a real build and doesn't run in Expo Go.

## One-time setup

### Windows PC
1. Install **iTunes** and **iCloud** from **Apple's website**, not the Microsoft Store. If the
   Store versions are installed, uninstall them first.
2. Open iTunes, sign in with your Apple ID, and connect the iPhone by USB. Tap **Trust** on the
   phone.
3. In iTunes, on the iPhone's summary page, turn on **"Sync with this iPhone over Wi-Fi"**. That
   lets AltStore refresh without a cable.
4. Install **AltServer** for Windows from [altstore.io](https://altstore.io).
   - Run it **as administrator**.
   - Allow it through Windows Firewall on **private networks**.
5. Click the AltServer tray icon → **Install AltStore** → pick your iPhone → enter your Apple ID.

### iPhone
1. Settings → Privacy & Security → **Developer Mode** → on, then restart. This is required on iOS 16+.
2. Settings → General → **VPN & Device Management** → your Apple ID → **Trust**.
3. Open AltStore once to confirm it launches.

### TV
- Settings → General → External Device Manager → **Device Connection Manager** →
  Access Notification: *First Time Only*.
- Reserve the TV's IP in your router, so it doesn't change.

## Check the TV from your PC (optional, no iPhone needed)

Needs [Node.js 22 LTS](https://nodejs.org) and Git.

```powershell
npm install
npm run probe -- 192.168.1.50 --art --apps     # press Allow on the TV
```
You should see `ms.channel.connect`, the volume moves, and Art Mode status and installed apps print.

## Build the .ipa (GitHub Actions)

1. GitHub → **Actions** → **iOS IPA (for AltStore)** → **Run workflow**.
2. When it finishes (~15–25 min), download the **FrameRemote-ipa** artifact from the run page
   and unzip it to get `FrameRemote.ipa`.

Pushing a tag `v*` also triggers a build.

> The repo is private, so macOS runner minutes count 10× against GitHub's free 2,000/month,
> which is about **8 builds**. A cheap Linux job runs the tests first, so broken commits don't
> use macOS minutes.

## Install (and update) with AltStore

1. Put `FrameRemote.ipa` where the iPhone's **Files** app can see it. The easiest way is to drop
   it into **iCloud Drive** on the PC (iCloud for Windows is already installed). Downloading the
   artifact in Safari on the phone also works.
2. On the iPhone: AltStore → **My Apps** → **+** (top left) → pick `FrameRemote.ipa`. Keep the PC
   with AltServer on and on the same Wi-Fi while it installs.
3. Open Frame Remote, allow **Local Network**, enter the TV's IP, tap **Save & connect**, and
   press **Allow** on the TV.

To **update**, build a new `.ipa` and install it the same way. The pairing token and the TV's
certificate fingerprint are kept.

## Making changes

There is only a release build, so **every change has to go through a new CI build and an
AltStore reinstall** before it reaches the phone. To save builds:
- run `npm run typecheck` and `npm test` first;
- use `npm run probe` to try TV behaviour from the PC;
- group several changes into one build.

## Free Apple ID limits

- **7 days.** Sideloaded apps stop opening after a week unless refreshed.
  - AltStore refreshes in the background when AltServer is running on a PC on the same Wi-Fi.
  - You can also tap **Refresh All** in AltStore → My Apps.
  - App data is kept across refreshes.
- **3 active apps, and AltStore counts as one.** AltStore + Frame Remote = 2.
- **About 10 App IDs per 7 days.** Reinstalling Frame Remote reuses its ID.
- Wake-on-LAN and auto-discovery are impossible: iOS reserves broadcast/multicast UDP for apps
  with an Apple-approved entitlement. Enter the IP by hand, and use the physical remote when the
  TV is fully off. Art Mode → TV works fine.

## Troubleshooting

- **AltStore can't find AltServer / refresh fails**: check that
  - AltServer is running (as admin) and allowed through the firewall on private networks;
  - iTunes Wi-Fi sync is on;
  - the phone and PC are on the same Wi-Fi.
  
  If it still fails, refresh over USB.
- **"Untrusted Developer" or apps won't open**: trust your Apple ID under VPN & Device Management,
  and check that Developer Mode is on.
- **"Maximum App ID limit reached"**: wait for the weekly reset.
- **App stopped opening after a week**: refresh in AltStore with AltServer reachable.
- **"Not reachable" in Test**:
  - check iOS Settings → Privacy & Security → **Local Network** → Frame Remote;
  - the phone must be on the same Wi-Fi, with no guest network, client isolation or VPN;
  - the TV must be on or in Art Mode.
- **"Refused by TV"**: press Allow on the TV, or delete *FrameRemote* from Device Connection
  Manager's list, then reconnect.
- **"TV's certificate changed"** (e.g. after a TV firmware update or a new TV): ⚙︎ →
  **Reset TV certificate**.
- **Art button flips power instead of art**: your firmware's Art API didn't answer, so the app
  falls back to a power-key tap. `npm run probe -- <ip> --art` shows what the API returns.
- **An app button does nothing**: app IDs vary by region. Use `npm run probe -- <ip> --apps`, or
  ⚙︎ → *Log installed apps*, then update `src/tv/keys.ts`.
- **CI build failed**: the run uploads `xcodebuild-log`, and the step output shows the first
  `error:` lines.

## Checks

```bash
npm run typecheck
npm test    # protocol + TvSocket wrapper + app connection code against a fake self-signed Frame (needs openssl)
```
GitHub Actions runs both before every macOS build.

## Layout

```
App.tsx                        the one screen
app.config.ts                  app name/bundle ID, iOS Info.plist (Local Network, ATS)
modules/tv-socket/ios/*.swift  native wss socket: LAN-only self-signed trust + cert pinning
modules/tv-socket/src/         WebSocket-shaped JS wrapper (TvSocket)
src/tv/protocol.ts             URLs + message builders/parsers (pure)
src/tv/SamsungRemote.ts        connection state machine: pairing, token, backoff reconnect
src/tv/art.ts                  Art Mode channel
src/tv/rest.ts                 /api/v2/ device info, REST app launch
src/tv/keys.ts                 KEY_* codes, app IDs
src/useRemote.ts               React hook: settings, cert pinning, AppState reconnect, actions
src/ui/*                       buttons, D-pad, number pad, status pill, setup sheet
tools/probe.mjs                TV diagnostics from a PC
test/                          fake TV + end-to-end checks
.github/workflows/ios-ipa.yml  unsigned IPA build
```
