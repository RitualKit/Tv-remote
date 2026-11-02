# Frame relay

2022+ Frames only accept remote control on **wss://TV:8002**, which uses a self-signed
certificate. Expo Go's WebSocket can't accept that certificate, so this script sits on any
always-on device on your Wi-Fi and bridges:

```
iPhone (Expo Go) ── ws://relay:8765 ──▶ relay.mjs ── wss://TV:8002 ──▶ The Frame
```

It passes the TV's own URL paths and messages through unchanged. Its only upstream is the
`TV_IP` you configure, so it is not an open proxy.

## Run it (any computer with Node 18+)

```bash
cd relay
npm install
TV_IP=192.168.1.50 node relay.mjs
# → "In the app, set Relay address to one of: 192.168.1.20:8765"
```

Put that address into the app (⚙︎ → Connection → Via relay → Relay address).

Options: `PORT=8765` (listen port), `TV_PORT=8002`, `QUIET=1` (no per-message logging).
Health check from your phone's browser: `http://<relay-ip>:8765/health`.

On macOS, allow incoming connections for `node` when the firewall asks.

## Probe the TV first (Milestone 0)

The probe runs from your computer and needs no phone. It shows what your TV supports:

```bash
node probe.mjs 192.168.1.50                 # pair on 8002 (press Allow on TV), send VOL+
node probe.mjs 192.168.1.50 --port 8001     # does the plain port work? (usually not on 2022+)
node probe.mjs 192.168.1.50 --art           # does the Art Mode API answer?
node probe.mjs 192.168.1.50 --apps          # list installed app IDs (Netflix, Prime, Disney+…)
node probe.mjs 192.168.1.50 --key KEY_HOME  # send any key
```

The probe saves its pairing token to `relay/.token` (git-ignored). The app pairs separately
and keeps its own token.

## Keep it running

### Old Android phone (Termux)
1. Install **Termux** from F-Droid. The Play Store build is outdated.
2. Set it up:
   ```bash
   pkg install nodejs git
   git clone <this repo> && cd Tv-remote/relay && npm install
   termux-wake-lock            # stop Android from sleeping Node
   TV_IP=192.168.1.50 node relay.mjs
   ```
3. In Android settings, disable battery optimisation for Termux and keep the phone plugged in.

### Raspberry Pi (recommended for 24/7)
```bash
sudo apt install -y nodejs npm
git clone <this repo> ~/Tv-remote && cd ~/Tv-remote/relay && npm install
sudo tee /etc/systemd/system/frame-relay.service >/dev/null <<'EOF'
[Unit]
Description=Frame Remote relay
After=network-online.target
Wants=network-online.target

[Service]
Environment=TV_IP=192.168.1.50
Environment=QUIET=1
WorkingDirectory=/home/pi/Tv-remote/relay
ExecStart=/usr/bin/node relay.mjs
Restart=always
RestartSec=3
User=pi

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now frame-relay
journalctl -u frame-relay -f   # logs
```

Give both the TV and the relay device a fixed IP (a DHCP reservation in your router), so the
addresses saved in the app keep working.
