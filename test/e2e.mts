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
import { findInstalledId, getAppStatus, getDeviceInfo, launchAppRest } from '../src/tv/rest';
import {
  APP_CATALOG,
  addApp,
  buttonForInstalledApp,
  defaultApps,
  findCatalogApp,
  isValidAppId,
  makeCustomApp,
  moveApp,
  parseInstalledApps,
  preferId,
  removeApp,
  restoreApps,
} from '../src/tv/apps';
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
import { httpProbe, scanForTvs, subnetCandidates, subnetLabel } from '../src/tv/discovery';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startFakeTv, FAKE_TOKEN, REVOKED_TOKEN, INSTALLED_APPS } from './fake-tv.mjs';

const SECURE = 28002;
const PLAIN = 28001;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (msg: string) => console.log(`✓ ${msg}`);

/** Node stand-in for the native TvSocket: TLS without certificate verification. */
const nodeSocket: SocketFactory = (url) => new NodeWebSocket(url, { rejectUnauthorized: false }) as unknown as SocketLike;

function runRemote(cfg: TvConfig, token: string | null, createSocket: SocketFactory = nodeSocket) {
  const statuses: ConnSnapshot[] = [];
  const tokens: (string | null)[] = [];
  const frames: { event: string; data: unknown }[] = [];
  const remote = new SamsungRemote({
    config: cfg,
    token,
    createSocket,
    onStatus: (s) => statuses.push(s),
    onToken: (t) => tokens.push(t),
    onLog: (l) => process.env.VERBOSE && console.log('   log:', l),
    onFrame: (event, data) => frames.push({ event, data }),
  });
  const waitFor = async (st: ConnSnapshot['status'], ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (statuses.at(-1)?.status === st) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for "${st}"; saw ${statuses.map((s) => s.status).join(' → ')}`);
  };
  return { remote, statuses, tokens, frames, waitFor };
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

function appButtonChecks() {
  // Catalog sanity: unique keys, valid IDs, no ID claimed by two apps.
  const keys = new Set<string>();
  const owner = new Map<string, string>();
  for (const app of APP_CATALOG) {
    assert.ok(!keys.has(app.key), `duplicate key ${app.key}`);
    keys.add(app.key);
    assert.ok(app.ids.length > 0 && /^#[0-9A-Fa-f]{6}$/.test(app.color), app.key);
    for (const id of app.ids) {
      assert.ok(isValidAppId(id), `${app.key}: bad id ${id}`);
      assert.ok(!owner.has(id), `${id} used by ${owner.get(id)} and ${app.key}`);
      owner.set(id, app.key);
    }
  }
  for (const k of ['netflix', 'youtube', 'prime-video', 'disney-plus']) assert.ok(findCatalogApp(k));

  // IDs: numeric, alphanumeric "xxxxxxxxxx.Name", org.tizen.*; nothing with spaces/slashes.
  for (const id of ['3201907018807', 'rJeHak5zRg.Spotify', 'org.tizen.browser', '11101200001']) assert.ok(isValidAppId(id), id);
  for (const id of ['', 'ab', 'has space', '../etc', 'a/b', '.hidden']) assert.ok(!isValidAppId(id), id);

  // Defaults are copies: editing them never mutates the catalog.
  const d = defaultApps();
  assert.deepEqual(d.map((a) => a.key), ['netflix', 'youtube', 'prime-video', 'disney-plus']);
  d[0].ids.push('mutated');
  assert.ok(!findCatalogApp('netflix')!.ids.includes('mutated'));

  // Custom apps.
  const c = makeCustomApp('  Crunchyroll ', ' xYzCrunchy1.Crunchyroll ');
  assert.deepEqual([c.key, c.name, c.ids, c.custom], ['custom:xYzCrunchy1.Crunchyroll', 'Crunchyroll', ['xYzCrunchy1.Crunchyroll'], true]);
  assert.equal(makeCustomApp('', '3201234567890').name, '3201234567890', 'name falls back to the ID');

  // add / remove / move / preferId.
  let list = defaultApps();
  list = addApp(list, makeCustomApp('Netflix again', '3201907018807'));
  assert.equal(list.length, 4, 'an ID already on a button is not added twice');
  list = addApp(list, c);
  assert.equal(list.at(-1)!.key, c.key);
  assert.deepEqual(moveApp(list, 4, -1).map((a) => a.key)[3], c.key);
  assert.equal(moveApp(list, 0, -1), list, 'moving the first app up is a no-op');
  list = removeApp(list, 'youtube');
  assert.ok(!list.some((a) => a.key === 'youtube'));
  const disney = findCatalogApp('disney-plus')!;
  assert.equal(preferId(disney, '3201901017640').ids[0], '3201901017640');
  assert.equal(preferId(disney, 'not-an-id-of-disney'), disney);

  // Restoring from storage.
  assert.equal(restoreApps(undefined), null, 'nothing saved → defaults');
  assert.equal(restoreApps('garbage'), null);
  assert.deepEqual(restoreApps([]), [], 'an empty list is a valid choice');
  const restored = restoreApps([
    { key: 'disney-plus', name: 'Old name', color: '#000000', ids: ['3201901017640', 'stale-id-not-in-catalog'] },
    { key: c.key, name: c.name, ids: c.ids, color: c.color },
    { key: 'custom:broken', name: 'x', ids: [] },
    { key: 'removed-from-catalog', name: 'Gone', ids: ['3201111111111'] },
    { key: 'disney-plus', name: 'dup', ids: [] },
    null,
  ])!;
  assert.deepEqual(restored.map((a) => a.key), ['disney-plus', c.key]);
  assert.equal(restored[0].name, 'Disney+', 'catalog name wins');
  assert.equal(restored[0].ids[0], '3201901017640', 'saved (TV-confirmed) order kept');
  assert.ok(!restored[0].ids.includes('stale-id-not-in-catalog'));
  assert.deepEqual([...restored[0].ids].sort(), [...disney.ids].sort(), 'gains catalog IDs added later');

  // The TV's own app list.
  const installed = parseInstalledApps({ data: INSTALLED_APPS });
  assert.deepEqual(installed.map((a) => a.name), ['Crunchyroll', 'Disney+', 'Netflix', 'YouTube'], 'sorted; invalid IDs dropped');
  assert.deepEqual(parseInstalledApps(undefined), []);
  assert.deepEqual(parseInstalledApps({ data: 'nope' }), []);
  const fromTv = installed.map(buttonForInstalledApp);
  const disneyBtn = fromTv.find((b) => b.key === 'disney-plus')!;
  assert.equal(disneyBtn.ids[0], '3202204027038', 'known app → catalog entry, reported ID first');
  assert.equal(fromTv.find((b) => b.name === 'Crunchyroll')!.key, 'custom:xYzCrunchy1.Crunchyroll', 'unknown app → custom');
  ok('app buttons: catalog, custom apps, add/remove/move, restore, TV app list');
}

async function discoveryChecks() {
  // Subnet maths.
  const c = subnetCandidates('192.168.1.23');
  assert.equal(c.length, 253);
  assert.equal(c[0], '192.168.1.1');
  assert.equal(c.at(-1), '192.168.1.254');
  assert.ok(!c.includes('192.168.1.23'), 'skips the phone itself');
  assert.deepEqual(subnetCandidates('0.0.0.0'), [], 'no Wi-Fi → nothing to scan');
  assert.deepEqual(subnetCandidates('100.64.3.9'), [], 'carrier NAT is not a home LAN');
  assert.equal(subnetLabel('10.0.7.42'), '10.0.7.x');

  // Scanner: concurrency cap, progress, sort order (Frame first), cancellation.
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const tvsAt: Record<string, { name: string; frameTv: boolean }> = {
      '192.168.1.7': { name: 'Bedroom TV', frameTv: false },
      '192.168.1.40': { name: 'The Frame', frameTv: true },
    };
    const probe = async (ip: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(Math.random() * 5);
      inFlight--;
      return tvsAt[ip] ?? null;
    };
    const progress: number[] = [];
    const found = await scanForTvs(c, probe, { concurrency: 8, onProgress: (done) => progress.push(done) });
    assert.ok(maxInFlight <= 8 && maxInFlight > 1, `concurrency respected (max ${maxInFlight})`);
    assert.equal(progress.at(-1), 253);
    assert.deepEqual(found.map((t) => t.ip), ['192.168.1.40', '192.168.1.7'], 'Frame listed first');

    let probed = 0;
    let stop = false;
    const partial = await scanForTvs(c, async () => (++probed === 20 && (stop = true), null), {
      concurrency: 4,
      isCancelled: () => stop,
    });
    assert.deepEqual(partial, []);
    assert.ok(probed < 30, `stops soon after cancel (probed ${probed})`);
  }

  // httpProbe: non-TV JSON server → null; closed port → null; silent server → null within timeout.
  {
    const listen = (handler: http.RequestListener) =>
      new Promise<http.Server>((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, '127.0.0.1', () => resolve(s));
      });
    const port = (s: http.Server) => (s.address() as AddressInfo).port;

    const notTv = await listen((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"hello":1}'));
    assert.equal(await httpProbe(900, port(notTv))('127.0.0.1'), null, 'JSON without device info is not a TV');

    const closedPort = port(notTv);
    await new Promise((r) => notTv.close(r));
    assert.equal(await httpProbe(900, closedPort)('127.0.0.1'), null, 'closed port');

    const silent = await listen(() => {}); // accepts, never answers
    const t0 = Date.now();
    assert.equal(await httpProbe(300, port(silent))('127.0.0.1'), null, 'silent host');
    assert.ok(Date.now() - t0 < 1500, 'probe gives up at its timeout');
    silent.closeAllConnections();
    silent.close();
  }
  ok('discovery: subnet candidates, scan concurrency/progress/sort/cancel, probe timeouts');
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

  // App status checks (GET /api/v2/applications/<id>).
  assert.equal(await getAppStatus(cfg, '3201907018807'), 'installed');
  assert.equal(await getAppStatus(cfg, '3201601007625'), 'missing');
  assert.equal(await getAppStatus({ tvIp: '127.0.0.1', httpPort: 1 }, '3201907018807', 500), 'unknown', 'TV unreachable is not "missing"');
  assert.deepEqual(await findInstalledId(cfg, findCatalogApp('disney-plus')!.ids), { status: 'installed', id: '3202204027038' });
  assert.deepEqual(await findInstalledId(cfg, ['3201601007625']), { status: 'missing' });
  ok('app status: installed / missing / unknown; first installed ID wins');

  // The TV's installed-app list over the remote socket.
  {
    const r = runRemote(cfg, token);
    r.remote.connect();
    await r.waitFor('connected', 1000);
    assert.equal(r.remote.requestInstalledApps(), true);
    const t0 = Date.now();
    while (!r.frames.some((f) => f.event === 'ed.installedApp.get') && Date.now() - t0 < 2000) await sleep(20);
    const frame = r.frames.find((f) => f.event === 'ed.installedApp.get');
    assert.ok(frame, 'TV answered ed.installedApp.get');
    assert.equal(parseInstalledApps(frame!.data).length, 4);
    r.remote.disconnect();
    ok('installed-app list arrives over the remote socket and parses');
  }

  // The scan's probe recognises the (fake) Frame.
  const probed = await httpProbe(900, PLAIN)('127.0.0.1');
  assert.equal(probed?.modelName, 'QN55LS03BAFXZA');
  assert.equal(probed?.frameTv, true);
  ok('scan probe identifies the Frame');

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
  appButtonChecks();
  await tvSocketWrapperChecks();
  await discoveryChecks();
  await fakeTvChecks();
  console.log('\nAll checks passed.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
