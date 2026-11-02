# Frame Remote

A phone remote for a Samsung **The Frame** TV. It is built with Expo and runs in **Expo Go**,
with no native modules and no dev build. It has:
- D-pad, Back, Home, Menu, Source, Info, Guide
- volume and channel, with repeat-while-held
- mute and Power (tap toggles Art↔TV, hold turns the TV off), plus an Art/TV button
- a collapsible number pad and Netflix / YouTube / Prime / Disney+ shortcuts
- haptics, a connection status pill and auto-reconnect

Background research and design decisions are in [docs/PLAN.md](docs/PLAN.md).

## How it connects

| TV | Path | Why |
|---|---|---|
| 2016–2021 sets | **Direct**: `ws://TV:8001` | plain WebSocket, which Expo Go can do |
| **2022+ Frames** (yours) | **Relay**: phone → `ws://relay:8765` → `wss://TV:8002` | the TV refuses 8001, and Expo Go can't accept the TV's self-signed certificate on 8002 |

The relay is a ~150-line Node script ([relay/](relay/README.md)). Run it on the computer you
develop on, and later on a Raspberry Pi or an old Android phone so the remote works 24/7.

## Quick start

```bash
npm install
npx expo start                                 # scan the QR with the iPhone Camera → opens in Expo Go
# second terminal:
cd relay && npm install && TV_IP=<tv-ip> node relay.mjs
```

In the app, the settings sheet opens on first launch:
1. **TV IP address**: find it on the TV under Settings → General → Network → Network Status → IP Settings.
2. **Connection**: choose *Via relay* and enter the address the relay printed (e.g. `192.168.1.20:8765`).
3. Tap **Test**. It should show your model name. Then tap **Save & connect**.
4. On the TV, choose **Allow** when prompted. The token is saved, so you won't be asked again.

Before involving the phone, you can check the TV from your computer:
`cd relay && node probe.mjs <tv-ip> --art --apps`

## Checks

```bash
npm run typecheck   # tsc
npm test            # end-to-end: app connection code → relay → fake self-signed Frame (needs openssl)
```

## Troubleshooting

- **iPhone**: Settings → Privacy & Security → **Local Network → Expo Go ON**. If it is off,
  nothing on your LAN is reachable.
- Phone, TV and relay must be on the **same Wi-Fi/subnet**: no guest network, no AP/client
  isolation, no VLAN split, and the phone VPN off.
- The TV must be **on or in Art Mode**. From fully off it can't be woken: Expo Go has no UDP, so
  no Wake-on-LAN. Use the physical remote.
- Do the first pairing in TV mode, so the **Allow** prompt is visible.
- TV: Settings → General → External Device Manager → **Device Connection Manager**:
  - set Access Notification to *First Time Only*;
  - in Device List, delete "FrameRemote" if it shows as *Denied*, then reconnect.
- TV: Settings → General → Network → Expert Settings → **Power On with Mobile** / IP Remote ON.
  The wording varies by year.
- In the phone's Safari, `http://<relay-ip>:8765/health` should return `{"ok":true}`.
- macOS: allow incoming connections for `node` in the firewall prompt.
- **"Refused by TV"** in Direct mode means your set needs the relay. In relay mode, re-check
  Device Connection Manager.
- **Connected but keys do nothing**: ⚙︎ → Forget pairing, then re-pair. Check the debug log
  in ⚙︎ and the relay's console.
- **Art button flips power instead of art**: your firmware's Art API didn't answer, so the app
  fell back to a power-key tap, which on The Frame also toggles Art↔TV.
  `node probe.mjs <ip> --art` shows what the Art API returns.
- **An app button does nothing**: app IDs vary by region. Run `node probe.mjs <ip> --apps`, or
  ⚙︎ → *Log installed apps*, then update `src/tv/keys.ts`.

## Layout

```
App.tsx                  the one screen
src/tv/protocol.ts       URLs + message builders/parsers (pure)
src/tv/SamsungRemote.ts  connection state machine: pairing, token, backoff reconnect
src/tv/art.ts            Art Mode channel (get/set artmode status)
src/tv/rest.ts           /api/v2/ device info, REST app launch
src/tv/keys.ts           KEY_* codes, app IDs
src/useRemote.ts         React hook: settings, AppState reconnect, actions
src/ui/*                 buttons, D-pad, number pad, status pill, setup sheet
relay/                   relay.mjs (bridge), probe.mjs (TV diagnostics)
test/                    fake TV + end-to-end test
```
