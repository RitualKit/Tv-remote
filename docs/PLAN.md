# Samsung The Frame Remote — Expo Go plan

## Context
The repo is empty (`/home/user/Tv-remote`, no commits). The goal is a one-screen TypeScript Expo app that runs **in Expo Go only** (no native modules, no dev build) and controls the user's **2022/23 The Frame** from an **iPhone** over home Wi-Fi. The fallback is a **relay on a cheap device**: the computer that already runs `npx expo start` during development, later an old Android phone (Termux) or a Pi Zero.

---

## 1. Findings & recommendation

**Protocol** (verified from `samsungtvws` source, the de-facto reference implementation):
- Remote URL: `/api/v2/channels/samsung.remote.control?name=<base64 name>&token=<t>`. Port 8001 is `ws://`, port 8002 is `wss://` with a self-signed cert.
- First event is `ms.channel.connect`, and any token is at `data.token`. `ms.channel.unauthorized` (or `ms.channel.timeOut`) means denied: forget the token. Skip `ms.edenTV.update`, `ms.voiceApp.hide`, `ms.remote.touchEnable/Disable`.
- Key: `{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"KEY_X","Option":"false","TypeOfRemote":"SendRemoteKey"}}`. Hold = `Press` … `Release`.
- App launch over WS: `ms.channel.emit` + `{event:"ed.apps.launch",to:"host",data:{action_type:"DEEP_LINK",appId,metaTag:""}}`. Both WS methods are fire-and-forget. REST: `POST /api/v2/applications/<id>`. Use both.
- Info: `GET /api/v2/` returns `device.modelName`, `FrameTVSupport`, `TokenAuthSupport`, `PowerState`.
- Art: channel `/api/v2/channels/com.samsung.art-app`, no token needed. After `ms.channel.connect`, wait for `ms.channel.ready`. Send `ms.channel.emit` `{event:"art_app_request",to:"host",data:"<JSON string>"}`, where the inner object is `{request:"get_artmode_status"|"set_artmode_status",value:"on"|"off",id,request_id}` (uuid). The reply is a `d2d_service_message` whose `data` is a JSON string, matched by `request_id`.

**Port reality for a 2022/23 Frame:**
- The `samsungtvws` maintainer says 8002 is required and "8001 will not work" (issue #108, 2022 LS03B).
- A 2024 Frame returns `ms.channel.unauthorized` on 8001 (ha-samsungtv-smart #435).
- On 2022+ sets, the art API also requires 8002 when it reports `secured`.
- So direct `ws://8001` will **probably be refused**. It costs 5 minutes to confirm, so we still probe it.

**Why not direct wss://8002 in Expo Go:** RN's WebSocket (SocketRocket on iOS) validates TLS with no JS override. The TV cert is only valid for `127.0.0.1`, so even installing it as a trusted root on the iPhone fails the hostname check. ATS and network-security-config changes need a native build.

**Rejected: SmartThings cloud.**
- Personal access tokens issued since Dec 2024 last 24 h, so it would need an OAuth SmartApp.
- The API became paid (~$4.99/mo personal) from Oct 2026.
- Remote keys go through a deprecated `execute` path, and every key press takes a cloud round-trip.
- Possible later add-on just for power-on-from-off. Out of scope for v1.

**Recommendation: relay transport.**
- `relay/relay.mjs` is about 60 lines of Node with the `ws` dependency, run with `TV_IP=… node relay.mjs`.
- It serves `http://0.0.0.0:8765` and mirrors the TV's paths. WS upgrades on `/api/v2/channels/*` are piped to `wss://TV_IP:8002/<same path+query>` with `rejectUnauthorized:false`. HTTP `/api/v2/*` is proxied to `https://TV_IP:8002`.
- Because the paths are identical, **the app has one client**. A transport is just a base URL:
  - direct: `ws://<tv>:8001`
  - relay: `ws://<relay>:8765`
- Upstream connects only to the configured `TV_IP` (not an open proxy). Client messages are buffered until upstream is open. Each side closes when the other closes.

**Expo Go facts:**
- Expo Go already loads JS from Metro over `http://<LAN-IP>:8081`, so cleartext LAN `ws://` and `http://` work, and it already holds the iOS Local Network permission.
- `app.json` ATS / cleartext / `NSLocalNetworkUsageDescription` keys do **not** apply in Expo Go.
- No UDP means no discovery and no Wake-on-LAN, so the IP is entered manually and the app can't power on from fully off. The Frame stays on the network in Art Mode.
- Packages: `expo-haptics`, `@react-native-async-storage/async-storage`, `expo-status-bar`, all installed via `npx expo install`. Base64 via Hermes `btoa`. A tiny inline uuid helper.

## 2. Project structure
```
App.tsx                    single screen: status header, remote, setup modal
app.json                   dark UI, portrait
src/tv/keys.ts             KEY_* map, app IDs
src/tv/protocol.ts         pure: buildUrl(transport, channel, name, token), keyMsg, launchMsg, artMsg, parseFrame
src/tv/SamsungRemote.ts    connection class: state machine, pairing, reconnect, send/hold, launch
src/tv/art.ts              one-shot art-channel request with timeout
src/tv/rest.ts             fetchWithTimeout: deviceInfo(), launchAppRest()
src/storage.ts             AsyncStorage {tvIp, token, transport:'direct'|'relay', relayHost}
src/useRemote.ts           hook: owns SamsungRemote, AppState listener, exposes status + actions
src/ui/RemoteButton.tsx    Pressable + haptics + optional repeat-while-held
src/ui/{DPad,NumberPad,StatusPill,SetupModal,AppRow}.tsx
relay/relay.mjs  relay/probe.mjs  relay/package.json  relay/README.md (Termux + systemd)
```

## 3. Connection / pairing / reconnect
**States:** `idle → connecting → awaitingAllow → connected`, plus `unauthorized` and `error(msg)`.

**connect():**
1. Build the URL from the transport. Always add `&token=` when one is stored.
2. On `onopen`: go to `awaitingAllow` and start a 30 s timer. If no event arrives within 3 s, send the Tizen register frame once (experimental, from #435).
3. On `ms.channel.connect`: persist `data.token` if present, go to `connected`, reset backoff, and play a success haptic.
4. On `unauthorized`: clear the token and stop auto-retry. The UI says "Approve on TV / check Device Connection Manager".
5. On timeout, or a close before connect: go to `error` and schedule a retry.

**Reconnect:**
- A non-user `onclose` retries with backoff 1→2→4→8→15 s (capped).
- `AppState` going `active` reconnects now; `background` closes the socket.
- A key press while disconnected triggers `connect()`. Keys aren't queued, so there are no delayed surprise presses.
- Tapping the status pill forces a reconnect.

**Key map:**
| Group | Keys |
|---|---|
| Power | `KEY_POWER` |
| D-pad | `KEY_UP/DOWN/LEFT/RIGHT`, `KEY_ENTER` |
| Navigation | `KEY_RETURN` (back), `KEY_HOME`, `KEY_MENU`, `KEY_SOURCE`, `KEY_INFO`, `KEY_GUIDE` |
| Volume | `KEY_VOLUP`, `KEY_VOLDOWN`, `KEY_MUTE` |
| Channel | `KEY_CHUP`, `KEY_CHDOWN`, `KEY_CH_LIST` |
| Numbers | `KEY_0`–`KEY_9` |

Volume and channel buttons repeat Click every ~150 ms while held.

**Power / Art:**
- Power tap sends `KEY_POWER`. On The Frame this toggles TV↔Art; verify on your set.
- Power long-press asks for confirmation, then holds `KEY_POWER` for ~3 s for a full off (unverified, test in M5).
- The Art button sends `get_artmode_status`, then `set_artmode_status` with the opposite value, with a 4 s timeout. If the art API is silent (2022 firmware before 1622 timed out), it falls back to a `KEY_POWER` tap.
- Off → on is impossible here. The UI says "TV is off — use the physical remote".

**Apps:** each launch sends WS `ed.apps.launch` and REST `POST` together.
| App | ID |
|---|---|
| YouTube | `111299001912` |
| Netflix | `3201907018807` (alt `11101200001`) |
| Prime Video | `3201910019365` (unverified) |
| Disney+ | `3201901017640` (unverified) |

Unverified IDs get confirmed in M6 via `ed.installedApp.get` logged in the probe.

## 4. UI (dark, one screen, portrait, 56pt+ targets)
```
 The Frame   ● Connected (relay)     ⚙︎     ← pill: green/amber/red, tap = reconnect
 [ ⏻ Power ]                 [ 🖼 Art ]
 [ Source ]   [ Home ]   [ Menu ]
              ▲
          ◀  OK  ▶                          ← ~240pt D-pad, 88pt OK
              ▼
 [ ↩ Back ]                  [ Info ]
 VOL [+] [−]   [ 🔇 ]   CH [+] [−]          ← tall rockers
 [Netflix] [YouTube] [Prime] [Disney+]
 ▸ Number pad                               ← collapses to 3×4: 1–9, CH list, 0, OK
```
- Colors: background `#0B0B0F`, buttons `#1C1C22`, accent `#4F8CFF`.
- Haptics: Light per key, Medium for power and art.
- Setup modal:
  - TV IP
  - Transport (Direct 8001 / Relay host:port)
  - "Test", which shows `modelName` and `TokenAuthSupport` from `/api/v2/`
  - "Forget pairing"
  - A debug log of the last 20 raw frames

## 5. Build order (each step has a milestone)
0. **Relay + CLI probe on your computer:** `relay/probe.mjs <tv-ip>` connects `wss://:8002`, prints events, saves the token, sends `KEY_VOLUP`, then runs `get_artmode_status`.
   - **M0:** the TV shows Allow, the volume moves, and the art status prints. This proves the TV side independently of the phone.
1. **Scaffold:** `npx create-expo-app@latest . --template blank-typescript`, then `npx expo install expo-haptics @react-native-async-storage/async-storage`. Add a temporary probe screen with buttons for direct 8001, direct wss 8002, and relay, plus a raw log.
   - **M1:** the iPhone connects via relay and VOL+ works. We also record what 8001 and 8002 do, which sets the default transport.
2. **`protocol.ts`, `SamsungRemote.ts`, `storage.ts`.**
   - **M2:** kill and reopen Expo Go → it reconnects with no Allow prompt.
3. **Remote UI:** D-pad, nav row, volume/channel with repeat, haptics, status pill.
   - **M3:** you can navigate TV menus from the phone.
4. **Reconnect + AppState.**
   - **M4:** toggle phone Wi-Fi, background the app, and restart the relay → the status recovers by itself.
5. **Power + Art.**
   - **M5:** Art toggles Art↔TV; long-press Power turns the TV off.
6. **Apps + number pad.**
   - **M6:** YouTube and Netflix open; digits change the channel.
7. **Always-on relay:** `relay/README.md` covers Termux (`pkg install nodejs`, `termux-wake-lock`) and a Pi systemd unit.
   - **M7:** the remote works with your computer off.
8. **Polish:** setup modal, error copy, README troubleshooting.

## 6. Testing on your iPhone + troubleshooting
- Run `npx expo start` and scan the QR with the iPhone Camera.
  - Phone and computer must share the Wi-Fi.
  - `--tunnel` helps reach Metro, but the TV and relay must still be on the LAN.
- Run the relay in a second terminal: `cd relay && npm i && TV_IP=<ip> node relay.mjs`.
- In the app, set the relay host to the computer's LAN IP (the same one Metro shows) on port `:8765`.
- Find the TV IP under Settings → General → Network → Network Status → IP Settings. Reserve it in the router's DHCP; do the same for the relay device.

Checklist:
- [ ] iPhone: Settings → Privacy & Security → **Local Network → Expo Go ON**. If Expo Go was denied earlier, nothing on the LAN works.
- [ ] Same Wi-Fi/subnet for phone, TV, and relay. No guest network, client isolation, VLAN split, or phone VPN.
- [ ] The TV is on or in Art Mode, not fully off. Do the first pairing in TV mode so the Allow prompt is visible.
- [ ] TV: Settings → General → External Device Manager → **Device Connection Manager** → Access Notification = **First Time Only**. In the Device List, delete any Denied "FrameRemote" entry.
- [ ] TV: Settings → General → Network → Expert Settings → **Power On with Mobile** / IP Remote ON (wording varies).
- [ ] From the computer, `curl http://<tv-ip>:8001/api/v2/` returns JSON. In iPhone Safari, `http://<relay-ip>:8765/api/v2/` returns JSON.
- [ ] macOS: allow incoming connections for `node` in the firewall prompt.
- [ ] Connected but keys do nothing → clear the token, re-pair, and check the probe log.

## 7. Risks & open questions
- **Unverified:** the Tizen register-frame need, `KEY_POWER` long-press = full off, the art API on your firmware, and the Prime/Disney IDs. M0, M5, and M6 test each one.
- The remote depends on the relay device being on. An old Android phone with Termux can sleep or kill Node; a Pi Zero 2 W is the reliable choice.
- There's no power-on from fully off. SmartThings or a dev build with UDP could add this later.
- Open: exact model code (e.g. QN55LS03B…) and firmware version. Read them from Settings → Support → About This TV before M0.

## Verification
- `npx tsc --noEmit` passes.
- `npx tsx` runs a quick assertion script over the `protocol.ts` builders and parser.
- `relay/probe.mjs` verifies the TV end-to-end without the phone.
- The real-device milestones M0–M7 above.

## Sources
- samsungtvws source (protocol, art channel, key codes): https://github.com/xchwarze/samsung-tv-ws-api
- 2022 Frame needs 8002 / art API notes: https://github.com/xchwarze/samsung-tv-ws-api/issues/108
- Tizen 9 Frame pairing on 8002, 8001 unauthorized: https://github.com/ollo69/ha-samsungtv-smart/issues/435
- 8001 vs 8002 per-model behaviour, app-launch methods: https://github.com/TheFab21/ha-samsungtv-smart and https://github.com/TheFab21/ha-samsungtv-smart/pull/281
- Browser-based Samsung remote (cert only valid for 127.0.0.1, app IDs): https://github.com/eyadmaherrr/tv-remote
- SmartThings PAT 24 h limit: https://community.homey.app/t/is-there-anyone-who-has-a-solution-for-smartthings-changes-to-personal-access-tokens-pat-to-24h/126384 and https://developer.smartthings.com/docs/getting-started/authorization-and-permissions
- SmartThings API becoming paid (Oct 2026): https://hackaday.com/2026/07/28/samsungs-smartthings-api-terminates-free-access/
- SmartThings TV capabilities: https://community.smartthings.com/t/samsung-tv-capabilities-samsungvd-ambient/268102
