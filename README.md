# Frame Remote

An iPhone remote for a Samsung **The Frame** (2022+). It's an Expo / React Native app, built in
the cloud as an unsigned `.ipa` and installed with **Sideloadly** from a Windows PC. No Mac and
no paid Apple account are needed.

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

**Windows PC**
- [Node.js 22 LTS](https://nodejs.org) and Git.
- **iTunes** and **iCloud**. Sideloadly expects Apple's own installers rather than the Microsoft
  Store versions; check [sideloadly.io](https://sideloadly.io) for the current requirement.
- [Sideloadly](https://sideloadly.io).

**iPhone**
- Settings → Privacy & Security → **Developer Mode** → on, then restart. This is required on iOS 16+.
  The switch only appears after the first sideload attempt.

**TV**
- Settings → General → External Device Manager → **Device Connection Manager** →
  Access Notification: *First Time Only*.
- Reserve the TV's IP in your router, so it doesn't change.

## 0. Check the TV from your PC (optional, no iPhone needed)

```powershell
npm install
npm run probe -- 192.168.1.50 --art --apps     # press Allow on the TV
```
You should see `ms.channel.connect`, the volume moves, and Art Mode status and installed apps print.

## 1. Build the .ipa (GitHub Actions)

GitHub → **Actions** → **iOS IPA (for Sideloadly)** → **Run workflow**, then pick a variant:

| Variant | Installs as | Use it for |
|---|---|---|
| `dev` | Frame Remote (Dev) | development: loads JS live from `npx expo start` on your PC |
| `release` | Frame Remote | everyday use: JS bundled in, works with the PC off |

When the run finishes (~15–25 min), download the artifact zip from the run page and extract
`FrameRemote-<variant>.ipa`. Pushing a tag `v*` also builds `release`.

> The repo is private, so macOS runner minutes count 10× against GitHub's free 2,000/month,
> which is about 8 builds. You only need a new build when native code or native dependencies change.

## 2. Install with Sideloadly

1. Connect the iPhone by USB, unlock it, and tap **Trust** if asked.
2. In Sideloadly, drag the `.ipa` in, enter your Apple ID, then click **Start**. Enter the 2FA code if asked.
3. On the iPhone: Settings → General → **VPN & Device Management** → your Apple ID → **Trust**.
4. Open the app. Allow **Local Network**, enter the TV IP, choose **Save & connect**, then
   press **Allow** on the TV.

The pairing token and the TV's certificate fingerprint are saved. Reinstalling the same variant
keeps them.

## 3. Develop with the dev build

```powershell
npm install
npx expo start          # scan the QR with the iPhone Camera → opens "Frame Remote (Dev)"
```
The phone and PC must be on the same Wi-Fi. JS and UI changes reload live, so no rebuild or CI
minutes are needed. Native changes (`modules/`, new native packages, `app.config.ts`) need a new
`dev` build.

## Free Apple ID limits (7 days)

- Sideloaded apps **stop opening after 7 days**. To renew, either:
  - turn on Sideloadly's **auto-refresh**, which re-signs over Wi-Fi while the PC and Sideloadly
    are running (see its FAQ for the exact requirements); or
  - re-sideload the same `.ipa` with Sideloadly. That takes about a minute, and app data is kept.
- At most **3** sideloaded apps at once; the dev and release variants use 2.
- About **10 new App IDs per week**. Reinstalling the same bundle ID doesn't use a new one.
- Wake-on-LAN and auto-discovery are impossible: iOS reserves broadcast/multicast UDP for apps
  with an Apple-approved entitlement. Enter the IP by hand, and use the physical remote when the
  TV is fully off. Art Mode → TV works fine.

## Troubleshooting

- **"Untrusted Developer" or the app won't open**: trust the profile under VPN & Device
  Management, and check that Developer Mode is on.
- **"Maximum App ID limit reached"**: wait for the weekly reset, or reuse a bundle ID you already
  installed.
- **App stopped opening after a week**: re-sideload (see above).
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
- **CI build failed**: the run uploads `xcodebuild-log`, and the step summary shows the first
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
app.config.ts                  dev/release variants, iOS Info.plist (Local Network, ATS)
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
