// Checks that run without a TV or an iPhone:
//  1. protocol builders/parsers
//  2. the TvSocket JS wrapper against a fake native module (same events the Swift code emits)
//  3. the app's connection code (src/tv/*) against a fake self-signed Frame over wss, with Node's
//     `ws` standing in for the native socket (certificate checks off, like TvSocket on a LAN IP)
//
//   npm test        (needs `openssl` on PATH to mint a throwaway cert)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { SamsungRemote, ConnSnapshot } from '../src/tv/SamsungRemote';
import { SocketFactory, SocketLike } from '../src/tv/socket';
import { getArtMode, toggleArtMode } from '../src/tv/art';
import { getDeviceInfo, launchAppRest } from '../src/tv/rest';
import {
  TvConfig,
  artRequestMessage,
  base64,
  channelUrl,
  isPrivateIPv4,
  keyMessage,
  parseArtReply,
  parseFrame,
} from '../src/tv/protocol';
import { TvSocket, TvSocketEvents, TvSocketNative } from '../modules/tv-socket/src/TvSocket';
import { startFakeTv, FAKE_TOKEN, REVOKED_TOKEN } from './fake-tv.mjs';

const SECURE = 28002;
const PLAIN = 28001;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (msg: string) => console.log(`✓ ${msg}`);

/** Node stand-in for the native TvSocket: TLS without certificate verification. */
const nodeSocket: SocketFactory = (url) => new NodeWebSocket(url, { rejectUnauthorized: false }) as unknown as SocketLike;

function runRemote(cfg: TvConfig, token: string | null, createSocket: SocketFactory = nodeSocket) {
  const statuses: ConnSnapshot[] = [];
  const tokens: (string | null)[] = [];
  const remote = new SamsungRemote({
    config: cfg,
    token,
    createSocket,
    onStatus: (s) => statuses.push(s),
    onToken: (t) => tokens.push(t),
    onLog: (l) => process.env.VERBOSE && console.log('   log:', l),
  });
  const waitFor = async (st: ConnSnapshot['status'], ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (statuses.at(-1)?.status === st) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for "${st}"; saw ${statuses.map((s) => s.status).join(' → ')}`);
  };
  return { remote, statuses, tokens, waitFor };
}

/** In-memory stand-in for the Swift module: records calls, lets the test emit native events. */
class FakeNative implements TvSocketNative {
  opened: { id: string; url: string; pin: string | null }[] = [];
  sent: { id: string; text: string }[] = [];
  closed: string[] = [];
  private listeners = new Map<string, Set<(e: any) => void>>();

  open(id: string, url: string, pin: string | null) {
    this.opened.push({ id, url, pin });
  }
  send(id: string, text: string) {
    this.sent.push({ id, text });
  }
  close(id: string) {
    this.closed.push(id);
  }
  addListener<K extends keyof TvSocketEvents>(event: K, fn: TvSocketEvents[K]) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return { remove: () => this.listeners.get(event)!.delete(fn) };
  }
  emit<K extends keyof TvSocketEvents>(event: K, payload: Parameters<TvSocketEvents[K]>[0]) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(payload);
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

function protocolChecks() {
  assert.equal(base64('FrameRemote'), Buffer.from('FrameRemote').toString('base64'));
  assert.equal(base64('Télé ✓ 📺'), Buffer.from('Télé ✓ 📺').toString('base64'));
  assert.equal(base64('ab'), 'YWI=');
  assert.equal(
    channelUrl({ tvIp: '192.168.1.50' }, 'samsung.remote.control', 'FrameRemote', 'a b'),
    'wss://192.168.1.50:8002/api/v2/channels/samsung.remote.control?name=RnJhbWVSZW1vdGU%3D&token=a%20b',
  );
  assert.deepEqual(JSON.parse(keyMessage('KEY_VOLUP')), {
    method: 'ms.remote.control',
    params: { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: 'false', TypeOfRemote: 'SendRemoteKey' },
  });
  const { message, requestId } = artRequestMessage('get_artmode_status');
  assert.equal(typeof JSON.parse(message).params.data, 'string', 'art data must be a JSON string');
  const reply = parseFrame(JSON.stringify({ event: 'd2d_service_message', data: JSON.stringify({ request_id: requestId, value: 'on' }) }))!;
  assert.equal(parseArtReply(reply, requestId)?.value, 'on');
  assert.equal(parseArtReply(reply, 'someone-else'), null);
  assert.equal(parseFrame('not json'), null);
  for (const ip of ['192.168.1.50', '10.0.0.2', '172.16.0.1', '172.31.255.255']) assert.ok(isPrivateIPv4(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '256.1.1.1', 'tv.local', '192.168.1', '']) assert.ok(!isPrivateIPv4(ip), ip);
  ok('protocol builders, parsers, private-IP check');
}

async function tvSocketWrapperChecks() {
  // Open → certificate reported → messages → send → close.
  {
    const native = new FakeNative();
    const certs: string[] = [];
    const s = new TvSocket('wss://192.168.1.50:8002/x', native, { pinnedSha256: 'abc', onCertificate: (c) => certs.push(c) });
    const events: string[] = [];
    s.onopen = () => events.push('open');
    s.onmessage = (e) => events.push(`msg:${e.data}`);
    s.onclose = (e) => events.push(`close:${e.code}`);
    assert.deepEqual(native.opened, [{ id: native.opened[0].id, url: 'wss://192.168.1.50:8002/x', pin: 'abc' }]);
    const id = native.opened[0].id;
    assert.throws(() => s.send('too early'), /not open/);
    native.emit('onOpen', { id: 'someone-else', certSha256: 'zzz' }); // other socket: ignored
    native.emit('onOpen', { id, certSha256: 'f00d' });
    native.emit('onMessage', { id, data: 'hello' });
    s.send('ping');
    assert.deepEqual(native.sent, [{ id, text: 'ping' }]);
    assert.equal(s.certSha256, 'f00d');
    assert.deepEqual(certs, ['f00d']);
    s.close();
    native.emit('onMessage', { id, data: 'after close' }); // must not be delivered
    assert.deepEqual(native.closed, [id]);
    assert.deepEqual(events, ['open', 'msg:hello']);
    assert.equal(native.listenerCount(), 0, 'listeners removed on close');
  }
  // Native-side close removes listeners and reports the code.
  {
    const native = new FakeNative();
    const s = new TvSocket('wss://192.168.1.50:8002/x', native);
    const id = native.opened[0].id;
    let closedWith = -1;
    s.onclose = (e) => (closedWith = e.code);
    native.emit('onOpen', { id });
    native.emit('onClose', { id, code: 1006, reason: 'gone' });
    assert.equal(closedWith, 1006);
    assert.equal(s.readyState, 3);
    assert.equal(native.listenerCount(), 0);
  }
  // Certificate changed (fatal) → SamsungRemote reports it and stops retrying.
  {
    const native = new FakeNative();
    const r = runRemote({ tvIp: '192.168.1.50' }, null, (url) => new TvSocket(url, native, { pinnedSha256: 'old' }));
    r.remote.connect();
    const id = native.opened[0].id;
    native.emit('onError', { id, message: "The TV's certificate changed since pairing.", fatal: true });
    native.emit('onClose', { id, code: 1006 });
    await r.waitFor('error');
    await sleep(1500);
    assert.equal(native.opened.length, 1, 'no reconnect attempts after a fatal error');
    assert.match(r.statuses.at(-1)!.message ?? '', /certificate changed/);
    r.remote.disconnect();
  }
  ok('TvSocket wrapper: events, id filtering, send/close, fatal cert error stops retries');
}

async function fakeTvChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-e2e-'));
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k`, '-out', `${dir}/c`, '-days', '1', '-subj', '/CN=127.0.0.1'],
    { stdio: 'ignore' },
  );
  const tls = { key: fs.readFileSync(`${dir}/k`), cert: fs.readFileSync(`${dir}/c`), securePort: SECURE, plainPort: PLAIN };
  let tv = await startFakeTv(tls);
  const cfg: TvConfig = { tvIp: '127.0.0.1', wssPort: SECURE, httpPort: PLAIN };

  // First pairing: awaitingAllow → connected, token reported.
  let token: string | null = null;
  {
    const r = runRemote(cfg, null);
    r.remote.connect();
    await r.waitFor('connected');
    assert.ok(r.statuses.some((s) => s.status === 'awaitingAllow'));
    token = r.tokens.at(-1) ?? null;
    assert.equal(token, FAKE_TOKEN);
    assert.equal(r.remote.sendKey('KEY_VOLUP'), true);
    r.remote.holdKey('KEY_POWER', 200);
    r.remote.launchApp('111299001912');
    await sleep(400);
    r.remote.disconnect();
    ok('pairing over wss; token saved; keys sent');
  }

  // Reopen with the stored token → connected without a new token (no Allow prompt).
  {
    const r = runRemote(cfg, token);
    r.remote.connect();
    await r.waitFor('connected', 1000);
    assert.equal(r.tokens.length, 0);
    r.remote.disconnect();
    ok('reconnect with stored token, no prompt');
  }

  // What the TV actually received.
  {
    const msgs = tv.state.received.map((x: any) => x.msg);
    assert.ok(tv.state.received.every((x: any) => x.name === 'FrameRemote'));
    assert.ok(msgs.some((m: any) => m.params?.DataOfCmd === 'KEY_VOLUP' && m.params.Cmd === 'Click'));
    assert.deepEqual(
      msgs.filter((m: any) => m.params?.DataOfCmd === 'KEY_POWER').map((m: any) => m.params.Cmd),
      ['Press', 'Release'],
    );
    assert.ok(msgs.some((m: any) => m.params?.event === 'ed.apps.launch' && m.params.data.appId === '111299001912'));
    ok('TV received Click, Press/Release hold, app launch');
  }

  // Revoked token → unauthorized, token cleared, no retry storm.
  {
    const r = runRemote(cfg, REVOKED_TOKEN);
    r.remote.connect();
    await r.waitFor('unauthorized');
    assert.deepEqual(r.tokens, [null]);
    await sleep(1500);
    assert.equal(r.statuses.at(-1)!.status, 'unauthorized', 'must not auto-retry after a refusal');
    r.remote.disconnect();
    ok('revoked token → unauthorized, token cleared, no retry loop');
  }

  // Art Mode.
  assert.equal(await getArtMode(cfg, nodeSocket), 'off');
  assert.equal(await toggleArtMode(cfg, nodeSocket), 'on');
  assert.equal(tv.state.artMode, 'on');
  assert.equal(await toggleArtMode(cfg, nodeSocket), 'off');
  ok('Art Mode get / toggle');

  // REST over plain HTTP.
  const info = await getDeviceInfo(cfg);
  assert.equal(info.modelName, 'QN55LS03BAFXZA');
  assert.equal(info.tokenAuth, true);
  assert.equal(await launchAppRest(cfg, '3201907018807'), true);
  assert.equal(await launchAppRest(cfg, 'bogus'), false);
  ok('device info + REST app launch');

  // Auto-reconnect: TV drops off the network, comes back → connected again by itself.
  {
    const r = runRemote(cfg, token);
    r.remote.connect();
    await r.waitFor('connected');
    await tv.close();
    await r.waitFor('error', 3000);
    tv = await startFakeTv(tls);
    await r.waitFor('connected', 8000);
    r.remote.disconnect();
    assert.equal(r.statuses.at(-1)!.status, 'idle');
    ok('auto-reconnect after the TV drops and returns');
  }

  await tv.close();
}

async function main() {
  protocolChecks();
  await tvSocketWrapperChecks();
  await fakeTvChecks();
  console.log('\nAll checks passed.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
