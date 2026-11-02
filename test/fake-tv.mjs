// A fake 2022-style Frame for tests:
//  - wss/https on SECURE_PORT (self-signed): token pairing, art channel, REST
//  - ws/http on PLAIN_PORT: refuses the remote channel like a 2022+ set does on 8001
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';

export const FAKE_TOKEN = 'tok-12345';
export const KNOWN_APPS = new Set(['3201907018807', '111299001912']);

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
    res.writeHead(404);
    res.end();
  };

  const secure = https.createServer({ key, cert }, rest);
  const plain = http.createServer(rest);

  new WebSocketServer({ server: secure }).on('connection', (ws, req) => {
    const u = new URL(req.url, 'https://x');
    ws.send(JSON.stringify({ event: 'ms.edenTV.update', data: {} })); // startup noise
    if (u.pathname.endsWith('samsung.remote.control')) {
      const name = Buffer.from(u.searchParams.get('name') ?? '', 'base64').toString();
      if (u.searchParams.get('token') === FAKE_TOKEN) {
        ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { id: 'c1', clients: [] } }));
      } else {
        // simulate the user pressing "Allow" after a moment
        setTimeout(() => ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { id: 'c1', token: FAKE_TOKEN } })), 300);
      }
      ws.on('message', (d) => state.received.push({ name, msg: JSON.parse(d.toString()) }));
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

  new WebSocketServer({ server: plain }).on('connection', (ws) => {
    ws.send(JSON.stringify({ event: 'ms.channel.unauthorized' }));
    setTimeout(() => ws.close(), 50);
  });

  return new Promise((resolve) =>
    secure.listen(securePort, '127.0.0.1', () =>
      plain.listen(plainPort, '127.0.0.1', () =>
        resolve({
          state,
          close: () => {
            secure.closeAllConnections?.();
            plain.closeAllConnections?.();
            secure.close();
            plain.close();
          },
        }),
      ),
    ),
  );
}
