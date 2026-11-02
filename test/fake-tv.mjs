// A fake 2022-style Frame for tests:
//  - wss on securePort (self-signed): token pairing, revoked-token refusal, art channel
//  - http on plainPort: /api/v2/ device info and REST app launch (like the real TV on 8001)
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';

export const FAKE_TOKEN = 'tok-12345';
/** A token the TV no longer accepts → ms.channel.unauthorized. */
export const REVOKED_TOKEN = 'tok-revoked';
export const KNOWN_APPS = new Set(['3201907018807', '111299001912', '3202204027038']);
/** What the fake TV reports for ed.installedApp.get (shape as on real TVs). */
export const INSTALLED_APPS = [
  { appId: '3201907018807', app_type: 2, name: 'Netflix', icon: '/opt/netflix.png' },
  { appId: '111299001912', app_type: 2, name: 'YouTube', icon: '/opt/yt.png' },
  { appId: '3202204027038', app_type: 2, name: 'Disney+', icon: '' },
  { appId: 'xYzCrunchy1.Crunchyroll', app_type: 4, name: 'Crunchyroll', icon: '' },
  { appId: 'bad id with spaces', name: 'Broken' },
];

export function startFakeTv({ key, cert, securePort, plainPort }) {
  const state = { received: [], artMode: 'off', launches: [] };
  const info = {
    device: { name: 'Fake Frame', modelName: 'QN55LS03BAFXZA', FrameTVSupport: 'true', TokenAuthSupport: 'true', PowerState: 'on' },
  };

  const rest = (req, res) => {
    if (req.url === '/api/v2/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(info));
    }
    const m = req.url.match(/^\/api\/v2\/applications\/(.+)$/);
    if (m && req.method === 'POST') {
      state.launches.push(m[1]);
      res.writeHead(KNOWN_APPS.has(m[1]) ? 200 : 404);
      return res.end();
    }
    if (m && req.method === 'GET') {
      // App status: 200 + JSON for installed apps, 404 otherwise (like the real TV).
      if (!KNOWN_APPS.has(m[1])) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: m[1], name: 'App', running: false, visible: false, version: '1.0' }));
    }
    res.writeHead(404);
    res.end();
  };

  const secure = https.createServer({ key, cert }, rest);
  const plain = http.createServer(rest);

  const wssSecure = new WebSocketServer({ server: secure });
  wssSecure.on('connection', (ws, req) => {
    const u = new URL(req.url, 'https://x');
    ws.send(JSON.stringify({ event: 'ms.edenTV.update', data: {} })); // startup noise
    if (u.pathname.endsWith('samsung.remote.control')) {
      const name = Buffer.from(u.searchParams.get('name') ?? '', 'base64').toString();
      if (u.searchParams.get('token') === REVOKED_TOKEN) {
        // user removed us from Device Connection Manager / pressed Deny
        ws.send(JSON.stringify({ event: 'ms.channel.unauthorized' }));
        setTimeout(() => ws.close(), 50);
        return;
      }
      if (u.searchParams.get('token') === FAKE_TOKEN) {
        ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { id: 'c1', clients: [] } }));
      } else {
        // simulate the user pressing "Allow" after a moment
        setTimeout(() => ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { id: 'c1', token: FAKE_TOKEN } })), 300);
      }
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        state.received.push({ name, msg });
        if (msg.method === 'ms.channel.emit' && msg.params?.event === 'ed.installedApp.get') {
          ws.send(
            JSON.stringify({
              event: 'ed.installedApp.get',
              data: { data: INSTALLED_APPS },
            }),
          );
        }
      });
    } else if (u.pathname.endsWith('com.samsung.art-app')) {
      ws.send(JSON.stringify({ event: 'ms.channel.connect', data: {} }));
      ws.send(JSON.stringify({ event: 'ms.channel.ready', data: {} }));
      ws.on('message', (d) => {
        const inner = JSON.parse(JSON.parse(d.toString()).params.data);
        if (inner.request === 'set_artmode_status') state.artMode = inner.value;
        ws.send(
          JSON.stringify({
            event: 'd2d_service_message',
            data: JSON.stringify({ event: 'artmode_status', value: state.artMode, id: inner.id, request_id: inner.request_id }),
          }),
        );
      });
    }
  });

  return new Promise((resolve) =>
    secure.listen(securePort, '127.0.0.1', () =>
      plain.listen(plainPort, '127.0.0.1', () =>
        resolve({
          state,
          /** Simulates the TV dropping off the network: kills open sockets and stops listening. */
          close: () =>
            new Promise((done) => {
              for (const client of wssSecure.clients) client.terminate();
              wssSecure.close();
              secure.closeAllConnections?.();
              plain.closeAllConnections?.();
              plain.close();
              secure.close(() => done());
            }),
        }),
      ),
    ),
  );
}
