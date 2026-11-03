# Frame Remote

An iPhone remote for a Samsung **The Frame** (2022+). It's an Expo / React Native app, built in
the cloud as an unsigned `.ipa` and installed with **AltStore** from a Windows PC. No Mac and no
paid Apple account are needed.

It has:
- D-pad, Back, Home, Menu, Source, Info, Guide. **Drag the OK button** like a joystick to move (keep it
  out there to keep moving; back to the centre to stop). Drag diagonally to move diagonally (the app
  alternates up/down and left/right; switch it off in TV setup → Remote → *Diagonal dragging*). Hold **OK** still on an app tile for its
  options (Move / Remove). The arrow buttons still work too (hold to keep scrolling)
- volume and channel, with repeat-while-held
- mute and Power (tap toggles Art↔TV, hold turns the TV off), plus an Art/TV button
- a collapsible number pad and app shortcuts (Netflix / YouTube / Prime Video / Disney+ by default)
- haptics, a connection status pill and fast auto-reconnect: the connection is kept while the app is in the
  background and checked with a ping when you return, and keys pressed while it (re)connects are sent
  as soon as it's ready (if under 2 s old)
- finds the TV on your Wi-Fi automatically (subnet scan), or takes a typed IP
- an **Apps** page (swipe left from the remote, or tap the page dots) with big tiles for your apps;
  customise them from the TV's own app list, a built-in catalogue, or any app ID

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

## Releases and automatic updates

Every change merged into `main` is built and published automatically:
1. A pull request is merged into `main`.
2. The **Release to AltStore** workflow builds `FrameRemote.ipa`, about 15–25 min.
3. It publishes a GitHub Release `v1.2.<n>` containing the `.ipa` and an AltStore **source**
   (`source.json`).
4. AltStore sees the new version and offers the update.

Changes to docs (`*.md`, `docs/`) or tests only don't trigger a release. You can also start one
by hand: Actions → **Release to AltStore** → **Run workflow**.

### Add the source to AltStore (once)

1. On the iPhone: AltStore → **Sources** → **+** → paste:
   ```
   https://github.com/RitualKit/Tv-remote/releases/latest/download/source.json
   ```
2. Open the new **Frame Remote** source and tap **Free / Get** to install. Keep the PC with
   AltServer on and on the same Wi-Fi.
   - If you installed Frame Remote by hand before and AltStore won't replace it, delete the old
     copy first. You'll then pair with the TV once more.
3. Open Frame Remote and allow **Local Network**. The setup sheet scans your Wi-Fi and lists the
   Samsung TVs that answer, with Frames first. Tap yours, or type its IP. Then tap
   **Save & connect** and press **Allow** on the TV.
   - If the scan finds nothing on the first try, iOS may still have been asking for Local
     Network access. Allow it and tap **Scan Wi-Fi for TVs** again.

### Getting updates

AltStore → **My Apps** shows an update when a new release is out; tap **Update**. AltStore needs
AltServer reachable to sign it, just like a refresh.

The pairing token, TV certificate and app buttons are kept. TV setup → bottom of the sheet shows
the installed version, e.g. *Frame Remote 1.2.57 (57)*.

### Installing a build by hand (fallback)

Download `FrameRemote.ipa` from a release on the repo's **Releases** page, or from a workflow
run's artifact. Put it in iCloud Drive, then AltStore → **My Apps** → **+** → pick it.

The newest 5 releases are kept, so you can go back one if an update misbehaves.

### Who can change `main`

The **Protect main** ruleset means nothing lands on `main`, and so nothing ships, without a pull
request that you merge. Not even pushes from your own account can bypass it. To set it up
(once, after making the repo public): GitHub → **Settings** → **Rules** → **Rulesets** →
**New ruleset** → **New branch ruleset**:
- **Name:** `Protect main`; **Enforcement:** Active.
- **Bypass list:** leave empty.
- **Target branches:** Add target → **Include default branch**.
- **Rules:**
  - ✓ **Restrict deletions**
  - ✓ **Block force pushes**
  - ✓ **Require a pull request before merging**, with required approvals **0**. You can't approve
    your own PR; merging it is the approval.
  - ✓ **Require status checks to pass** → add **checks** (the PR workflow).

## Customising the app buttons

Swipe to the **Apps** page, then tap **Edit apps**, or long-press any app tile.
- **Your buttons:** each shows **On TV** or **Not found**, based on asking the TV about that app's ID.
  - A grey **?** means the TV couldn't be asked, e.g. it's off. Tap a badge to check again.
  - Reorder with ⌃ ⌄, remove with ✕.
- **On your TV:** **Load apps from TV** asks the TV for its installed apps; tap **+** to add one.
  Not every model answers this request. If yours doesn't, use the next two options.
- **Add any app:** a button name plus the app's Samsung ID. You can get IDs from the list above,
  or on your PC with `npm run probe -- <tv-ip> --apps`.
- **Add from list:** a searchable catalogue of about 30 common apps, with known IDs for different
  TV years. When the TV confirms one of an app's IDs, that ID is used first from then on.
- **Reset to default buttons** restores Netflix, YouTube, Prime Video and Disney+.

Your buttons are saved with the rest of the settings, and kept across AltStore updates.

## Making changes

Changes reach the phone only as a merged pull request → new release → AltStore update:
- Claude (or you) pushes a branch and opens a PR. The **checks** workflow (typecheck + tests) must
  pass, then you merge.
- Run `npm run typecheck` and `npm test` locally first. Use `npm run probe` to try TV behaviour
  from the PC without a build.

## Free Apple ID limits

- **7 days.** Sideloaded apps stop opening after a week unless refreshed.
  - AltStore refreshes in the background when AltServer is running on a PC on the same Wi-Fi.
  - You can also tap **Refresh All** in AltStore → My Apps.
  - App data is kept across refreshes.
- **3 active apps, and AltStore counts as one.** AltStore + Frame Remote = 2.
- **About 10 App IDs per 7 days.** Reinstalling Frame Remote reuses its ID.
- **Discovery is a subnet scan.** The app asks every address in the phone's /24 network
  (e.g. 192.168.1.1–254) for the TV's device description on port 8001.
  - SSDP/UPnP discovery and Wake-on-LAN are impossible: iOS reserves broadcast/multicast UDP for
    apps with an Apple-approved entitlement.
  - The scan only covers /24 networks. On a larger network, or if the TV is on a different
    subnet, type the IP instead.
  - Use the physical remote when the TV is fully off. Art Mode → TV works fine.

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
- **Scan finds no TV**: same checks as "Not reachable" below. Also note that a guest network, or
  a mesh system that puts the phone and TV on different subnets, hides the TV from the scan.
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
- **An app button does nothing**: open **Edit**. If the app shows **Not found**, its ID differs on
  your TV. Remove it and re-add it from **On your TV**, or add it by ID (`npm run probe -- <ip> --apps`).
- **CI build failed**: the run uploads `xcodebuild-log`, and the step output shows the first
  `error:` lines. Nothing is published when a build fails; the previous release stays current.
- **No update in AltStore**: AltStore → Sources → pull to refresh. Check the release exists on the
  repo's Releases page and that the source URL opens in Safari (the repo must be public).

## Checks

```bash
npm run typecheck
npm test    # protocol, app buttons, TvSocket wrapper, discovery scan, app connection code against a fake self-signed Frame (needs openssl)
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
src/tv/discovery.ts            Wi-Fi subnet scan for Samsung TVs (pure; probe injected)
src/useTvScan.ts               scan hook: phone IP via expo-network, progress, results
src/tv/keys.ts                 KEY_* codes
src/tv/apps.ts                 app catalogue + button list logic (pure)
src/useRemote.ts               React hook: settings, cert pinning, AppState reconnect, actions
src/ui/*                       buttons, D-pad, number pad, status pill, Apps grid, setup sheet, app-button editor
tools/probe.mjs                TV diagnostics from a PC
test/                          fake TV + end-to-end checks
.github/workflows/ios-ipa.yml  release: unsigned IPA → GitHub Release + AltStore source (push to main)
.github/workflows/checks.yml   required PR check: typecheck + tests
tools/make-altstore-source.mjs builds source.json for each release
```
