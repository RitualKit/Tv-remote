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
import { SamsungRemote, ConnSnapshot, BACKOFF_MS, QUEUE_WINDOW_MS } from '../src/tv/SamsungRemote';
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
import { buildSource } from '../tools/make-altstore-source.mjs';
import { createHoldGesture, createRepeatGesture, HoldCmd } from '../src/ui/holdGesture';
import { createJoystick, directionOf, keysFor } from '../src/ui/joystick';
import type { AddressInfo } from 'node:net';
import { startFakeTv, FAKE_TOKEN, REVOKED_TOKEN, INSTALLED_APPS } from './fake-tv.mjs';

const SECURE = 28002;
const PLAIN = 28001;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (msg: string) => console.log(`✓ ${msg}`);

/** Node stand-in for the native TvSocket: TLS without certificate verification, plus checkAlive via ping/pong. */
const nodeSocket: SocketFactory = (url) => {
  const ws = new NodeWebSocket(url, { rejectUnauthorized: false });
  // Like a browser/iOS WebSocket: an error with no handler attached (e.g. closing a socket
  // that is still opening) must not crash the process.
  ws.on('error', () => {});
  const sock = ws as unknown as SocketLike;
  sock.checkAlive = (timeoutMs) =>
    new Promise<boolean>((resolve) => {
      if (ws.readyState !== NodeWebSocket.OPEN) return resolve(false);
      const onPong = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        ws.off('pong', onPong);
        resolve(false);
      }, timeoutMs);
      ws.once('pong', onPong);
      ws.ping();
    });
  return sock;
};
/** Like nodeSocket, but the link "died" while the app was away: pings never come back. */
const deadOnResumeSocket: SocketFactory = (url) => {
  const sock = nodeSocket(url);
  sock.checkAlive = (timeoutMs) => new Promise((resolve) => setTimeout(() => resolve(false), Math.min(timeoutMs, 60)));
  return sock;
};

function runRemote(cfg: TvConfig, token: string | null, createSocket: SocketFactory = nodeSocket, now?: () => number) {
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
    now,
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
  pingResult: boolean | 'reject' = true;
  pings: { id: string; timeoutMs: number }[] = [];
  ping(id: string, timeoutMs: number) {
    this.pings.push({ id, timeoutMs });
    return this.pingResult === 'reject' ? Promise.reject(new Error('boom')) : Promise.resolve(this.pingResult);
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
  // checkAlive → native ping; false before open, and never rejects.
  {
    const native = new FakeNative();
    const sock = new TvSocket('wss://192.168.1.50:8002/x', native);
    const id = native.opened[0].id;
    assert.equal(await sock.checkAlive(1000), false, 'not open yet');
    assert.equal(native.pings.length, 0);
    native.emit('onOpen', { id });
    assert.equal(await sock.checkAlive(1000), true);
    assert.deepEqual(native.pings, [{ id, timeoutMs: 1000 }]);
    native.pingResult = false;
    assert.equal(await sock.checkAlive(1000), false);
    native.pingResult = 'reject';
    assert.equal(await sock.checkAlive(1000), false, 'a native failure reads as "not alive"');
    sock.close();
  }
  ok('TvSocket wrapper: events, id filtering, send/close, fatal cert error stops retries, checkAlive');
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

function holdGestureChecks() {
  // Fake clock + timers.
  let t = 0;
  let timers: { at: number; fn: () => void }[] = [];
  const advance = (ms: number) => {
    t += ms;
    for (const tm of timers.filter((x) => x.at <= t)) tm.fn();
    timers = timers.filter((x) => x.at > t);
  };
  const make = () => {
    const sent: { cmd: HoldCmd; at: number }[] = [];
    const g = createHoldGesture({
      send: (cmd) => sent.push({ cmd, at: t }),
      minHoldMs: 1000,
      now: () => t,
      setTimer: (fn, ms) => {
        const tm = { at: t + ms, fn };
        timers.push(tm);
        return tm;
      },
      clearTimer: (h) => {
        timers = timers.filter((x) => x !== h);
      },
    });
    return { g, sent };
  };

  // Tap → one Click; end() afterwards does nothing.
  {
    const { g, sent } = make();
    g.tap();
    g.end();
    assert.deepEqual(sent.map((x) => x.cmd), ['Click']);
  }
  // Long hold → Press now, Release when the finger lifts (already past the minimum).
  {
    const { g, sent } = make();
    g.holdStart();
    assert.equal(g.holding, true);
    advance(2500);
    g.end();
    assert.deepEqual(sent.map((x) => x.cmd), ['Press', 'Release']);
    assert.equal(sent[1].at - sent[0].at, 2500);
    assert.equal(g.holding, false);
  }
  // Lifted right after the hold was recognised → Release still waits for the 1 s minimum.
  {
    const { g, sent } = make();
    g.holdStart();
    advance(100);
    g.end();
    assert.deepEqual(sent.map((x) => x.cmd), ['Press'], 'release is deferred');
    advance(899);
    assert.equal(sent.length, 1);
    advance(1);
    assert.deepEqual(sent.map((x) => x.cmd), ['Press', 'Release']);
    assert.equal(sent[1].at - sent[0].at, 1000);
  }
  // Double holdStart / end are harmless (no second Press, no second Release); tap while held is ignored.
  {
    const { g, sent } = make();
    g.holdStart();
    g.holdStart();
    g.tap();
    advance(1200);
    g.end();
    g.end();
    advance(5000);
    assert.deepEqual(sent.map((x) => x.cmd), ['Press', 'Release']);
  }
  // Review finding (PR #2): a short hold, then a new hold before its deferred Release fires.
  // Must be ONE continuous hold on the TV: no second Press, no Release while the finger is down.
  {
    const { g, sent } = make();
    g.holdStart(); //   0 ms: Press
    advance(100);
    g.end(); //         100 ms: lifted early → Release deferred to 1000 ms
    advance(500);
    g.holdStart(); //   600 ms: held again
    advance(900); //    1500 ms: the old deferred Release must NOT have fired
    assert.deepEqual(sent.map((x) => x.cmd), ['Press'], 'no Press,Press / no Release mid-hold');
    assert.equal(g.holding, true);
    advance(500);
    g.end(); //         2000 ms: lifted after > 1 s since the Press → release now
    assert.deepEqual(sent.map((x) => x.cmd), ['Press', 'Release']);
    assert.equal(sent[1].at - sent[0].at, 2000, 'released when the finger lifted, 2 s after the Press');
    advance(5000);
    assert.equal(sent.length, 2, 'no stray Release later');
  }
  // A tap while a deferred Release is pending: Release first, then the Click (strict ordering).
  {
    const { g, sent } = make();
    g.holdStart();
    advance(100);
    g.end();
    advance(200);
    g.tap();
    assert.deepEqual(sent.map((x) => x.cmd), ['Press', 'Release', 'Click']);
    advance(5000);
    assert.equal(sent.length, 3, 'the cancelled deferred Release never fires');
  }

  // Direction keys: hold repeats Click until release.
  {
    const sent: HoldCmd[] = [];
    let tick: (() => void) | null = null;
    let cleared = 0;
    const g = createRepeatGesture({
      send: (cmd) => sent.push(cmd),
      intervalMs: 130,
      setRepeat: (fn) => ((tick = fn), 'handle'),
      clearRepeat: (h) => (assert.equal(h, 'handle'), cleared++),
    });
    g.tap();
    assert.deepEqual(sent, ['Click'], 'tap = one Click');
    g.holdStart();
    assert.equal(sent.length, 2, 'hold starts with an immediate Click');
    for (let i = 0; i < 5; i++) tick!();
    assert.equal(sent.length, 7, 'then one Click per interval');
    g.tap();
    assert.equal(sent.length, 7, 'tap while held is ignored');
    g.end();
    g.end();
    assert.equal(cleared, 1, 'repeat stops once, on release');
    assert.ok(sent.every((c) => c === 'Click'), 'arrows never send Press/Release');
  }
  ok('hold gesture: OK = Press…Release (1 s minimum); arrows = repeated Click; idempotent');
}

function joystickChecks() {
  let t = 0;
  let timers: { at: number; fn: () => void }[] = [];
  const advance = (ms: number) => {
    const until = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = until;
  };
  const setTimer = (fn: () => void, ms: number) => {
    const tm = { at: t + ms, fn };
    timers.push(tm);
    return tm;
  };
  const clearTimer = (h: unknown) => {
    timers = timers.filter((x) => x !== h);
  };
  const make = (diag = { on: false }) => {
    timers = [];
    const sent: string[] = [];
    const ok = createHoldGesture({ send: (cmd) => sent.push(`ok:${cmd}`), now: () => t, setTimer, clearTimer });
    const j = createJoystick({
      ok,
      diagonal: () => diag.on,
      onDirection: (d, repeat) => sent.push(repeat ? `${d}*` : d),
      threshold: 28,
      holdAfterMs: 400,
      repeatDelayMs: 350,
      repeatEveryMs: 130,
      setTimer,
      clearTimer,
    });
    return { j, sent };
  };

  // Dominant axis decides the direction.
  assert.equal(directionOf(31, -30), 'right');
  assert.equal(directionOf(30, -31), 'up');
  assert.equal(directionOf(-40, 5), 'left');
  assert.equal(directionOf(2, 40), 'down');

  // Tap with a little jitter → OK click.
  {
    const { j, sent } = make();
    j.start();
    j.move(3, -2);
    j.end();
    assert.deepEqual(sent, ['ok:Click']);
  }
  // Hold still → OK press-and-hold; dragging after that is ignored.
  {
    const { j, sent } = make();
    j.start();
    advance(400);
    assert.deepEqual(sent, ['ok:Press']);
    assert.equal(j.mode, 'ok-hold');
    j.move(60, 0);
    advance(1200);
    j.end();
    assert.deepEqual(sent, ['ok:Press', 'ok:Release'], 'no direction once OK is held');
  }
  // Drag right → one step at once, repeats after the delay, stops on release; never OK.
  {
    const { j, sent } = make();
    j.start();
    j.move(10, 0);
    assert.equal(sent.length, 0, 'below the threshold nothing happens');
    j.move(30, 5);
    assert.deepEqual(sent, ['right']);
    advance(349);
    assert.deepEqual(sent, ['right'], 'no repeat before the delay');
    advance(1);
    assert.deepEqual(sent, ['right', 'right*']);
    advance(260);
    assert.deepEqual(sent, ['right', 'right*', 'right*', 'right*']);
    j.end();
    advance(2000);
    assert.equal(sent.length, 4, 'repeat stops on release');
    assert.ok(!sent.some((x) => x.startsWith('ok')), 'a drag never fires OK');
  }
  // The OK hold timer is cancelled once the finger starts dragging.
  {
    const { j, sent } = make();
    j.start();
    j.move(0, 40);
    advance(500); // repeats at 350 ms and 480 ms; the 400 ms OK-hold timer must not fire
    assert.deepEqual(sent, ['down', 'down*', 'down*']);
    assert.ok(!sent.includes('ok:Press'));
    j.end();
  }
  // Switch direction mid-drag → immediate first step in the new direction.
  {
    const { j, sent } = make();
    j.start();
    j.move(0, -40);
    j.move(40, -5);
    assert.deepEqual(sent, ['up', 'right']);
    j.end();
  }
  // Back to centre (hysteresis = half the threshold) stops repeating; out again restarts.
  {
    const { j, sent } = make();
    j.start();
    j.move(35, 0);
    j.move(20, 0); // still ≥ 14 px out: keep going right, no new step
    assert.deepEqual(sent, ['right']);
    j.move(10, 0); // back inside 14 px
    assert.equal(j.direction, null);
    advance(2000);
    assert.deepEqual(sent, ['right'], 'no repeats while centred');
    j.move(35, 0);
    assert.deepEqual(sent, ['right', 'right']);
    j.move(5, 0);
    j.end();
    assert.ok(!sent.some((x) => x.startsWith('ok')), 'returning to centre and lifting is not an OK tap');
  }
  // System cancel: no OK tap from a pending touch; a held OK is still released.
  {
    const { j, sent } = make();
    j.start();
    j.cancel();
    assert.equal(sent.length, 0, 'cancelled touch is not a tap');
    j.start();
    advance(450);
    j.cancel();
    advance(2000);
    assert.deepEqual(sent, ['ok:Press', 'ok:Release']);
  }
  // ── Diagonals ──
  assert.deepEqual(keysFor('up-right'), ['up', 'right']);
  assert.deepEqual(keysFor('down-left'), ['down', 'left']);
  assert.deepEqual(keysFor('left'), ['left']);
  assert.equal(directionOf(30, -30, true), 'up-right');
  assert.equal(directionOf(-30, 30, true), 'down-left');
  assert.equal(directionOf(40, -10, true), 'right', '14° is in the right-zone (±25°)');
  assert.equal(directionOf(40, -21, true), 'up-right', '27.7° is in the up-right zone (45±20°)');
  assert.equal(directionOf(30, -30, false), 'up', 'diagonals off: tie goes to vertical, as before');

  // 45° drag → both keys at once, then alternating repeats.
  {
    const { j, sent } = make({ on: true });
    j.start();
    j.move(30, -30);
    assert.deepEqual(sent, ['up', 'right']);
    assert.equal(j.direction, 'up-right');
    advance(350);
    advance(130);
    advance(130);
    assert.deepEqual(sent, ['up', 'right', 'up*', 'right*', 'up*']);
    j.end();
  }
  // Hysteresis: a right drag rising to 30° stays "right"; past 33° (25+8) into the diagonal it switches.
  {
    const { j, sent } = make({ on: true });
    j.start();
    j.move(40, -14.6); // 20°
    j.move(40, -23); //   ~30°: still right (inside 25° + 8°)
    assert.deepEqual(sent, ['right']);
    j.move(40, -30); //   ~36.9°: past 33° and inside up-right's ±20°
    assert.deepEqual(sent, ['right', 'up', 'right']);
    assert.equal(j.direction, 'up-right');
    j.move(40, -26); //   ~33°: still up-right (inside 20° + 8° of 45°)
    assert.equal(sent.length, 3, 'no flicker back to right near the edge');
    j.end();
  }
  // Diagonals off → a 45° drag is a single cardinal, never two keys.
  {
    const { j, sent } = make({ on: false });
    j.start();
    j.move(30, -30);
    advance(350 + 130 * 2);
    assert.deepEqual(sent, ['up', 'up*', 'up*', 'up*']);
    j.end();
  }
  // The setting is read live: switching it off mid-drag drops back to a cardinal.
  {
    const flag = { on: true };
    const { j, sent } = make(flag);
    j.start();
    j.move(30, -32);
    assert.deepEqual(sent, ['up', 'right']);
    flag.on = false;
    j.move(31, -33);
    assert.equal(j.direction, 'up');
    assert.deepEqual(sent, ['up', 'right', 'up']);
    j.end();
  }
  ok('OK joystick: tap, hold, drag with repeat, switch, dead-zone, cancel, diagonals + hysteresis');
}

function altstoreSourceChecks() {
  const base = {
    version: '1.2.57',
    build: '57',
    date: '2026-11-03T12:00:00Z',
    size: 31_457_280,
    downloadURL: 'https://github.com/RitualKit/Tv-remote/releases/download/v1.2.57/FrameRemote.ipa',
    iconURL: 'https://raw.githubusercontent.com/RitualKit/Tv-remote/main/assets/icon.png',
    sourceURL: 'https://github.com/RitualKit/Tv-remote/releases/latest/download/source.json',
    notes: 'Add customisable app buttons',
    privacy: { NSLocalNetworkUsageDescription: 'Talks to your TV', CFBundleName: 'not a usage key', NSFooUsageDescription: '' },
  };
  const src = buildSource(base);
  const app = src.apps[0];
  assert.equal(src.identifier, 'com.ritualkit.frameremote.source');
  assert.equal(src.sourceURL, base.sourceURL);
  assert.equal(app.bundleIdentifier, 'com.ritualkit.frameremote', 'must match app.config.ts');
  assert.equal(app.versions.length, 1);
  assert.deepEqual(
    { ...app.versions[0] },
    {
      version: '1.2.57',
      buildVersion: '57',
      date: '2026-11-03T12:00:00.000Z',
      localizedDescription: 'Add customisable app buttons',
      downloadURL: base.downloadURL,
      size: 31_457_280,
      minOSVersion: '16.4',
    },
  );
  assert.deepEqual(app.appPermissions, { entitlements: [], privacy: { NSLocalNetworkUsageDescription: 'Talks to your TV' } });
  assert.equal(app.version, '1.2.57', 'legacy fields mirror versions[0]');
  assert.equal(app.downloadURL, base.downloadURL);
  assert.equal(buildSource({ ...base, notes: '  ' }).apps[0].versions[0].localizedDescription, 'Build 57');
  for (const [k, v] of [
    ['version', '1.2'],
    ['version', 'v1.2.3'],
    ['build', 'x'],
    ['size', 0],
    ['downloadURL', 'http://insecure/FrameRemote.ipa'],
    ['iconURL', 'not a url'],
    ['sourceURL', 'ftp://x/source.json'],
    ['date', 'yesterday'],
  ] as const) {
    assert.throws(() => buildSource({ ...base, [k]: v } as any), Error, `rejects ${k}=${v}`);
  }

  // CLI, as CI runs it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altsrc-'));
  fs.writeFileSync(`${dir}/FrameRemote.ipa`, Buffer.alloc(1234, 7));
  fs.writeFileSync(`${dir}/privacy.json`, JSON.stringify({ NSLocalNetworkUsageDescription: 'LAN' }));
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '../tools/make-altstore-source.mjs');
  execFileSync(process.execPath, [cli, '--version', '1.2.9', '--build', '9', '--ipa', `${dir}/FrameRemote.ipa`,
    '--privacy', `${dir}/privacy.json`, '--repo', 'RitualKit/Tv-remote', '--notes', 'hello', '--out', `${dir}/source.json`], { stdio: 'pipe' });
  const out = JSON.parse(fs.readFileSync(`${dir}/source.json`, 'utf8'));
  const v = out.apps[0].versions[0];
  assert.equal(v.downloadURL, 'https://github.com/RitualKit/Tv-remote/releases/download/v1.2.9/FrameRemote.ipa');
  assert.equal(out.apps[0].iconURL, 'https://raw.githubusercontent.com/RitualKit/Tv-remote/main/assets/icon.png');
  assert.equal(v.size, 1234);
  assert.equal(out.sourceURL, 'https://github.com/RitualKit/Tv-remote/releases/latest/download/source.json');
  assert.deepEqual(out.apps[0].appPermissions.privacy, { NSLocalNetworkUsageDescription: 'LAN' });
  assert.throws(() => execFileSync(process.execPath, [cli, '--version', '1.2.9'], { stdio: 'pipe' }), 'missing args fail');
  ok('AltStore source: structure, permissions filter, validation, CLI');
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
    r.remote.sendKey('KEY_ENTER', 'Press');
    r.remote.sendKey('KEY_ENTER', 'Release');
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
    assert.deepEqual(
      msgs.filter((m: any) => m.params?.DataOfCmd === 'KEY_ENTER').map((m: any) => m.params.Cmd),
      ['Press', 'Release'],
      'held OK reaches the TV as Press then Release',
    );
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

  // ── Faster reconnect / no lost first press ──
  assert.equal(BACKOFF_MS[0], 250, 'first retry almost at once');
  const keysAtTv = (key: string) =>
    tv.state.received.filter((x: any) => x.msg.params?.DataOfCmd === key).map((x: any) => x.msg.params.Cmd);
  const settle = () => sleep(150);

  // A key pressed while connecting is delivered once connected.
  {
    const r = runRemote(cfg, token);
    r.remote.connect();
    assert.equal(r.remote.sendKey('KEY_VOLDOWN'), true, 'accepted (queued) while connecting');
    await r.waitFor('connected', 2000);
    await settle();
    assert.deepEqual(keysAtTv('KEY_VOLDOWN'), ['Click']);
    r.remote.disconnect();
  }
  // Stale presses (older than the window) are dropped, and a Release whose Press was dropped too.
  {
    const clock = { t: Date.now() };
    const r = runRemote(cfg, token, nodeSocket, () => clock.t);
    r.remote.connect();
    r.remote.sendKey('KEY_MUTE');
    r.remote.sendKey('KEY_INFO', 'Press');
    clock.t += QUEUE_WINDOW_MS + 500;
    r.remote.sendKey('KEY_INFO', 'Release');
    await r.waitFor('connected', 2000);
    await settle();
    assert.deepEqual(keysAtTv('KEY_MUTE'), [], 'stale click dropped');
    assert.deepEqual(keysAtTv('KEY_INFO'), [], 'no orphan Release without its Press');
    r.remote.disconnect();
  }
  // Back from the background, link alive: ping, no new connection; keys during the check arrive.
  {
    const r = runRemote(cfg, token);
    r.remote.connect();
    await r.waitFor('connected', 2000);
    const before = tv.state.remoteConnections;
    r.remote.suspend();
    r.remote.resume();
    assert.equal(r.remote.sendKey('KEY_CHUP'), true);
    await settle();
    assert.equal(tv.state.remoteConnections, before, 'kept connection reused, no reconnect');
    assert.equal(r.statuses.at(-1)!.status, 'connected');
    assert.deepEqual(keysAtTv('KEY_CHUP'), ['Click'], 'key pressed during the check delivered');
    r.remote.disconnect();
  }
  // Back from the background, link dead (no pong): reconnect at once and deliver the queued key.
  {
    const r = runRemote(cfg, token, deadOnResumeSocket);
    r.remote.connect();
    await r.waitFor('connected', 2000);
    const before = tv.state.remoteConnections;
    r.remote.suspend();
    r.remote.resume();
    r.remote.sendKey('KEY_CHDOWN');
    await sleep(400);
    assert.equal(tv.state.remoteConnections, before + 1, 'reconnected');
    assert.equal(r.statuses.at(-1)!.status, 'connected');
    assert.deepEqual(keysAtTv('KEY_CHDOWN'), ['Click'], 'queued key delivered on the new connection');
    r.remote.disconnect();
  }
  // Resume when not connected: connect right away.
  {
    const r = runRemote(cfg, token);
    r.remote.resume();
    await r.waitFor('connected', 2000);
    // The installed-app request is never queued: it reports "not sent" so the UI can say so.
    r.remote.disconnect();
    assert.equal(r.remote.requestInstalledApps(), false);
    r.remote.disconnect();
  }
  // Review finding (PR #5): holds queued while connecting must keep their duration at the TV.
  const timesAtTv = (key: string) =>
    tv.state.received.filter((x: any) => x.msg.params?.DataOfCmd === key).map((x: any) => ({ cmd: x.msg.params.Cmd, at: x.at }));
  {
    // Press and Release both queued 1 s apart (fake clock) → replayed 1 s apart (real time).
    const clock = { t: Date.now() };
    const r = runRemote(cfg, token, nodeSocket, () => clock.t);
    r.remote.connect();
    r.remote.sendKey('KEY_GUIDE', 'Press');
    clock.t += 1000;
    r.remote.sendKey('KEY_GUIDE', 'Release');
    r.remote.sendKey('KEY_TOOLS'); // pressed after the release → must arrive after it
    await r.waitFor('connected', 2000);
    await sleep(1300);
    const t = timesAtTv('KEY_GUIDE');
    assert.deepEqual(t.map((x: any) => x.cmd), ['Press', 'Release']);
    assert.ok(t[1].at - t[0].at >= 950, `hold kept (${t[1].at - t[0].at} ms)`);
    const tools = timesAtTv('KEY_TOOLS');
    assert.equal(tools.length, 1);
    assert.ok(tools[0].at >= t[1].at, 'order kept: the later click comes after the Release');
    r.remote.disconnect();
  }
  {
    // Press queued, connection comes up, finger lifts later → Release delayed by the Press's delay.
    const r = runRemote(cfg, token);
    r.remote.connect();
    r.remote.sendKey('KEY_SOURCE', 'Press');
    const pressedAt = Date.now();
    await r.waitFor('connected', 2000);
    await sleep(300);
    const heldFor = Date.now() - pressedAt; // what the user "held"
    r.remote.sendKey('KEY_SOURCE', 'Release');
    await sleep(heldFor + 200);
    const t = timesAtTv('KEY_SOURCE');
    assert.deepEqual(t.map((x: any) => x.cmd), ['Press', 'Release']);
    assert.ok(t[1].at - t[0].at >= heldFor - 60, `TV saw ${t[1].at - t[0].at} ms, user held ${heldFor} ms`);
    r.remote.disconnect();
  }
  {
    // holdKey() while connecting: the 600 ms hold is timed from when the Press reaches the TV.
    const r = runRemote(cfg, token);
    r.remote.connect();
    assert.equal(r.remote.holdKey('KEY_RED', 600), true);
    await r.waitFor('connected', 2000);
    await sleep(900);
    const t = timesAtTv('KEY_RED');
    assert.deepEqual(t.map((x: any) => x.cmd), ['Press', 'Release']);
    assert.ok(t[1].at - t[0].at >= 580, `full hold at the TV (${t[1].at - t[0].at} ms)`);
    r.remote.disconnect();
  }
  ok('reconnect: queued first press, stale drop + pairing, hold timing kept, resume ping (alive/dead), 250 ms first retry');

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
  holdGestureChecks();
  joystickChecks();
  altstoreSourceChecks();
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
