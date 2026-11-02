#!/usr/bin/env node
// Milestone 0: talk to the TV from your computer (no phone involved) to learn what it supports.
//
//   node probe.mjs <tv-ip> [--port 8002|8001] [--key KEY_VOLUP] [--art] [--apps]
//
// - prints device info from http://<tv>:8001/api/v2/
// - connects to the remote channel, prints every event, saves the pairing token to .token
// - sends one key (default KEY_VOLUP) once connected
// - --apps: asks for the installed-app list (to confirm Netflix/Prime/Disney+ IDs)
// - --art:  asks the art channel for get_artmode_status

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const ip = args.find((a) => !a.startsWith('--') && /^[\w.-]+$/.test(a));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
if (!ip) {
  console.log('usage: node probe.mjs <tv-ip> [--port 8002|8001] [--key KEY_VOLUP] [--art] [--apps]');
  process.exit(1);
}
const port = Number(opt('port', '8002'));
const key = opt('key', 'KEY_VOLUP');
const wantArt = args.includes('--art');
const wantApps = args.includes('--apps');
const TOKEN_FILE = new URL('./.token', import.meta.url);
const token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
const scheme = port === 8002 ? 'wss' : 'ws';
const name = Buffer.from('FrameRemote').toString('base64');
const tls = { rejectUnauthorized: false };

const url = (channel, withToken = true) =>
  `${scheme}://${ip}:${port}/api/v2/channels/${channel}?name=${encodeURIComponent(name)}` +
  (withToken && token ? `&token=${encodeURIComponent(token)}` : '');

async function deviceInfo() {
  try {
    const res = await fetch(`http://${ip}:8001/api/v2/`, { signal: AbortSignal.timeout(4000) });
    const d = (await res.json()).device ?? {};
    console.log('Device info:', {
      name: d.name,
      modelName: d.modelName,
      FrameTVSupport: d.FrameTVSupport,
      TokenAuthSupport: d.TokenAuthSupport,
      PowerState: d.PowerState,
      firmwareVersion: d.firmwareVersion,
    });
  } catch (e) {
    console.log(`Device info failed (${e.message}) — is the TV on / in Art Mode and on this network?`);
  }
}

function remote() {
  return new Promise((resolve) => {
    console.log(`\nConnecting ${url('samsung.remote.control').replace(/token=[^&]+/, 'token=***')}`);
    const ws = new WebSocket(url('samsung.remote.control'), tls);
    let gotEvent = false;
    const done = (ok) => {
      ws.close();
      resolve(ok);
    };
    const giveUp = setTimeout(() => {
      console.log('✗ No ms.channel.connect within 30 s (prompt not accepted?)');
      done(false);
    }, 30_000);

    ws.on('open', () => {
      console.log('socket open — look at the TV and press Allow if asked');
      setTimeout(() => {
        if (!gotEvent) {
          console.log('TV silent → sending register frame (Tizen 9 workaround)');
          ws.send(JSON.stringify({ method: 'ms.channel.connect', params: { deviceName: name, id: randomUUID(), type: 'native', token: '' } }));
        }
      }, 3000);
    });
    ws.on('message', (buf) => {
      gotEvent = true;
      const msg = JSON.parse(buf.toString());
      console.log('←', msg.event, msg.event === 'ed.installedApp.get' ? '' : JSON.stringify(msg.data ?? {}).slice(0, 200));
      if (msg.event === 'ed.installedApp.get') {
        for (const app of msg.data?.data ?? []) console.log(`   ${app.appId}\t${app.name}`);
        clearTimeout(giveUp);
        return done(true);
      }
      if (msg.event === 'ms.channel.connect') {
        if (msg.data?.token) {
          fs.writeFileSync(TOKEN_FILE, msg.data.token);
          console.log('✓ paired, token saved to relay/.token');
        }
        console.log(`→ ${key}`);
        ws.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } }));
        if (wantApps) {
          ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } }));
        } else {
          clearTimeout(giveUp);
          setTimeout(() => done(true), 1500);
        }
      }
      if (msg.event === 'ms.channel.unauthorized' || msg.event === 'ms.channel.timeOut') {
        console.log(`✗ ${msg.event}: TV refused this port/client. ${port === 8001 ? 'Try --port 8002.' : 'Check Device Connection Manager.'}`);
        clearTimeout(giveUp);
        done(false);
      }
    });
    ws.on('error', (e) => console.log('socket error:', e.message));
    ws.on('close', (code) => {
      console.log(`socket closed (${code})`);
      clearTimeout(giveUp);
      resolve(false);
    });
  });
}

function art() {
  return new Promise((resolve) => {
    console.log(`\nArt channel ${url('com.samsung.art-app', false)}`);
    const ws = new WebSocket(url('com.samsung.art-app', false), tls);
    const id = randomUUID();
    const send = () =>
      ws.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'art_app_request', to: 'host', data: JSON.stringify({ request: 'get_artmode_status', id, request_id: id }) } }));
    const t = setTimeout(() => {
      console.log('✗ Art API did not answer in 6 s (app will fall back to KEY_POWER)');
      ws.close();
      resolve();
    }, 6000);
    ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString());
      console.log('←', msg.event, typeof msg.data === 'string' ? msg.data.slice(0, 200) : '');
      if (msg.event === 'ms.channel.ready') send();
      if (msg.event === 'd2d_service_message') {
        clearTimeout(t);
        ws.close();
        resolve();
      }
    });
    ws.on('error', (e) => console.log('art socket error:', e.message));
  });
}

await deviceInfo();
await remote();
if (wantArt) await art();
process.exit(0);
