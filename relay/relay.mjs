#!/usr/bin/env node
// Frame Remote relay: bridges the phone (plain ws/http, which Expo Go can do) to the TV's
// secure port 8002 (self-signed TLS, which Expo Go cannot accept).
//
//   phone ──ws://relay:8765/api/v2/channels/...──▶ relay ──wss://TV:8002/api/v2/channels/...──▶ TV
//   phone ──http://relay:8765/api/v2/...─────────▶ relay ──https://TV:8002/api/v2/...─────────▶ TV
//
// Paths and query strings (name, token) pass through untouched, so the app speaks the exact
// same protocol in "direct" and "relay" mode. Upstream is only ever the configured TV_IP.
//
// Usage:  TV_IP=192.168.1.50 node relay.mjs        (optional: PORT=8765 TV_PORT=8002 QUIET=1)

import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';

const TV_IP = process.env.TV_IP;
const PORT = Number(process.env.PORT ?? 8765);
const TV_PORT = Number(process.env.TV_PORT ?? 8002);
const QUIET = process.env.QUIET === '1';

if (!TV_IP || !/^[\w.-]+$/.test(TV_IP)) {
  console.error('Set TV_IP, e.g.  TV_IP=192.168.1.50 node relay.mjs');
  process.exit(1);
}

const tls = { rejectUnauthorized: false }; // the TV's cert is self-signed — this is the whole point
const log = (...a) => !QUIET && console.log(new Date().toISOString().slice(11, 19), ...a);
const redact = (url) => url.replace(/token=[^&]+/, 'token=***');

// ---------------------------------------------------------------------------------------------
// HTTP: proxy /api/v2/* (device info, app launch). Falls back to plain :8001 if TLS fails.

function proxyHttp(req, res, body, secure = true) {
  const mod = secure ? https : http;
  const upstream = mod.request(
    {
      host: TV_IP,
      port: secure ? TV_PORT : 8001,
      path: req.url,
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json', 'content-length': body.length },
      timeout: 5000,
      ...(secure ? tls : {}),
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, { 'content-type': up.headers['content-type'] ?? 'application/json' });
      up.pipe(res);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (err) => {
    if (secure) return proxyHttp(req, res, body, false);
    log(`http ${req.method} ${req.url} failed: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `TV unreachable: ${err.message}` }));
  });
  upstream.end(body);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, tv: TV_IP }));
  }
  if (!req.url?.startsWith('/api/v2/')) {
    res.writeHead(404);
    return res.end();
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    log(`http ${req.method} ${req.url}`);
    proxyHttp(req, res, Buffer.concat(chunks));
  });
});

// ---------------------------------------------------------------------------------------------
// WebSocket: pipe /api/v2/channels/* to wss://TV:8002 frame-for-frame.

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/api/v2/channels/')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (client) => bridge(client, req.url));
});

// Close codes 1005/1006 are reserved and can't be sent; map them to something legal.
const safeCode = (code) => (code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);

function bridge(client, path) {
  const target = `wss://${TV_IP}:${TV_PORT}${path}`;
  const channel = path.split('?')[0].replace('/api/v2/channels/', '');
  log(`ws  open  ${redact(target)}`);
  const tv = new WebSocket(target, tls);
  const pending = [];

  client.on('message', (data, isBinary) => {
    if (tv.readyState === WebSocket.OPEN) tv.send(data, { binary: isBinary });
    else pending.push([data, isBinary]);
  });
  tv.on('open', () => {
    for (const [d, b] of pending.splice(0)) tv.send(d, { binary: b });
  });
  tv.on('message', (data, isBinary) => {
    if (!QUIET && !isBinary) {
      try {
        const ev = JSON.parse(data.toString()).event;
        if (ev) log(`ws  ${channel} ← ${ev}`);
      } catch {}
    }
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  tv.on('close', (code, reason) => {
    log(`ws  ${channel} TV closed (${code})`);
    if (client.readyState <= WebSocket.OPEN) client.close(safeCode(code), reason);
  });
  tv.on('error', (err) => {
    log(`ws  ${channel} TV error: ${err.message}`);
    if (client.readyState <= WebSocket.OPEN) client.close(1011, 'TV unreachable');
  });
  client.on('close', () => {
    if (tv.readyState === WebSocket.OPEN) tv.close(1000);
    else if (tv.readyState === WebSocket.CONNECTING) tv.terminate();
  });
  client.on('error', () => tv.terminate());
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`Frame relay → TV ${TV_IP}:${TV_PORT}`);
  console.log(`In the app, set Relay address to one of: ${ips.map((ip) => `${ip}:${PORT}`).join(', ') || `<this-ip>:${PORT}`}`);
});
