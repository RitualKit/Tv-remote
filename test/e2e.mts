// End-to-end check without a real TV: drives the app's connection code (src/tv/*) through
// relay/relay.mjs against a fake self-signed Frame (test/fake-tv.mjs).
//
//   npm test        (needs `openssl` on PATH to mint a throwaway cert)
import assert from 'node:assert/strict';
import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SamsungRemote, ConnSnapshot } from '../src/tv/SamsungRemote';
import { getArtMode, toggleArtMode } from '../src/tv/art';
import { getDeviceInfo, launchAppRest } from '../src/tv/rest';
import { TvConfig, artRequestMessage, base64, channelUrl, keyMessage, parseArtReply, parseFrame } from '../src/tv/protocol';
import { startFakeTv, FAKE_TOKEN } from './fake-tv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECURE = 28002;
const PLAIN = 28001;
const RELAY = 28765;
const RELAY_LATE = 28766;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const children: ChildProcess[] = [];
const ok = (msg: string) => console.log(`✓ ${msg}`);

function startRelay(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [path.join(ROOT, 'relay/relay.mjs')], {
    env: { ...process.env, TV_IP: '127.0.0.1', TV_PORT: String(SECURE), PORT: String(port), QUIET: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  return new Promise((resolve) => child.stdout!.once('data', () => resolve(child)));
}

function runRemote(cfg: TvConfig, token: string | null) {
  const statuses: ConnSnapshot[] = [];
  const tokens: (string | null)[] = [];
  const remote = new SamsungRemote({
    config: cfg,
    token,
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

async function main() {
  // --- pure protocol checks -------------------------------------------------------------------
  assert.equal(base64('FrameRemote'), Buffer.from('FrameRemote').toString('base64'));
  assert.equal(base64('Télé ✓ 📺'), Buffer.from('Télé ✓ 📺').toString('base64'));
  assert.equal(base64('ab'), 'YWI=');
  assert.equal(
    channelUrl({ tvIp: '10.0.0.5', mode: 'direct', relayHost: '' }, 'samsung.remote.control', 'FrameRemote', 'a b'),
    'ws://10.0.0.5:8001/api/v2/channels/samsung.remote.control?name=RnJhbWVSZW1vdGU%3D&token=a%20b',
  );
  assert.ok(channelUrl({ tvIp: 'x', mode: 'relay', relayHost: '10.0.0.9' }, 'c').startsWith('ws://10.0.0.9:8765/api/v2/channels/c?'));
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
  ok('protocol builders and parsers');

  // --- fake TV + relay ------------------------------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-e2e-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k`, '-out', `${dir}/c`, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  const tv = await startFakeTv({ key: fs.readFileSync(`${dir}/k`), cert: fs.readFileSync(`${dir}/c`), securePort: SECURE, plainPort: PLAIN });
  await startRelay(RELAY);
  const relay: TvConfig = { tvIp: '127.0.0.1', mode: 'relay', relayHost: `127.0.0.1:${RELAY}` };

  // 1. Plain port refuses (2022+ behaviour) → 'unauthorized', and no retry storm.
  {
    const r = runRemote({ tvIp: '127.0.0.1', mode: 'relay', relayHost: `127.0.0.1:${PLAIN}` }, null);
    r.remote.connect();
    await r.waitFor('unauthorized');
    await sleep(1500);
    assert.equal(r.statuses.at(-1)!.status, 'unauthorized', 'must not auto-retry after a refusal');
    r.remote.disconnect();
    ok('plain-port refusal → unauthorized, no retry loop');
  }

  // 2. First pairing via relay: awaitingAllow → connected, token reported.
  let token: string | null = null;
  {
    const r = runRemote(relay, null);
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
    ok('pairing through relay; token saved; keys sent');
  }

  // 3. Reopen with the stored token → connected without a new token (no Allow prompt).
  {
    const r = runRemote(relay, token);
    r.remote.connect();
    await r.waitFor('connected', 1000);
    assert.equal(r.tokens.length, 0);
    r.remote.disconnect();
    ok('reconnect with stored token, no prompt');
  }

  // 4. What the TV actually received.
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

  // 5. Art Mode through the relay.
  assert.equal(await getArtMode(relay), 'off');
  assert.equal(await toggleArtMode(relay), 'on');
  assert.equal(tv.state.artMode, 'on');
  assert.equal(await toggleArtMode(relay), 'off');
  ok('Art Mode get / toggle');

  // 6. REST through the relay (https upstream).
  const info = await getDeviceInfo(relay);
  assert.equal(info.modelName, 'QN55LS03BAFXZA');
  assert.equal(info.tokenAuth, true);
  assert.equal(await launchAppRest(relay, '3201907018807'), true);
  assert.equal(await launchAppRest(relay, 'bogus'), false);
  ok('device info + REST app launch');

  // 7. Auto-reconnect: relay down → error/backoff → relay up → connected → relay killed → back.
  {
    const r = runRemote({ ...relay, relayHost: `127.0.0.1:${RELAY_LATE}` }, token);
    r.remote.connect();
    await r.waitFor('error', 3000);
    const late = await startRelay(RELAY_LATE);
    await r.waitFor('connected', 8000);
    late.kill();
    await r.waitFor('error', 3000);
    const late2 = await startRelay(RELAY_LATE);
    await r.waitFor('connected', 8000);
    r.remote.disconnect();
    late2.kill();
    assert.equal(r.statuses.at(-1)!.status, 'idle');
    ok('auto-reconnect after relay restart');
  }

  tv.close();
  console.log('\nAll checks passed.');
}

main()
  .then(() => {
    children.forEach((c) => c.kill());
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    children.forEach((c) => c.kill());
    process.exit(1);
  });
