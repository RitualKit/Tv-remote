// Pure helpers for the Samsung Tizen "ms.*" WebSocket protocol.
// No React, no network: everything here can be unit-tested in Node.

export const CLIENT_NAME = 'FrameRemote';
export const DEFAULT_RELAY_PORT = 8765;

export type ConnectionMode = 'direct' | 'relay';

export interface TvConfig {
  tvIp: string;
  mode: ConnectionMode;
  /** "host" or "host:port" of the relay; only used when mode === 'relay'. */
  relayHost: string;
}

export type RemoteCmd = 'Click' | 'Press' | 'Release';

/** Channel names on the TV's /api/v2/channels/ endpoint. */
export const REMOTE_CHANNEL = 'samsung.remote.control';
export const ART_CHANNEL = 'com.samsung.art-app';

// ---------------------------------------------------------------------------
// Base64 (ASCII/UTF-8). Implemented here so we don't depend on a global btoa.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(input: string): number[] {
  const bytes: number[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return bytes;
}

export function base64(input: string): string {
  const bytes = utf8Bytes(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += b === undefined ? '=' : B64[(n >> 6) & 63];
    out += c === undefined ? '=' : B64[n & 63];
  }
  return out;
}

export function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// URLs

/** Adds the default relay port when the user typed only a host. */
export function normalizeRelayHost(host: string): string {
  const h = host.trim();
  if (!h) return h;
  return /:\d+$/.test(h) ? h : `${h}:${DEFAULT_RELAY_PORT}`;
}

/** ws://… base. Direct = TV's plain port 8001; relay = relay, which bridges to wss://TV:8002. */
export function wsBase(cfg: TvConfig): string {
  return cfg.mode === 'relay'
    ? `ws://${normalizeRelayHost(cfg.relayHost)}`
    : `ws://${cfg.tvIp.trim()}:8001`;
}

export function httpBase(cfg: TvConfig): string {
  return cfg.mode === 'relay'
    ? `http://${normalizeRelayHost(cfg.relayHost)}`
    : `http://${cfg.tvIp.trim()}:8001`;
}

export function channelUrl(
  cfg: TvConfig,
  channel: string,
  name: string = CLIENT_NAME,
  token?: string | null,
): string {
  let url = `${wsBase(cfg)}/api/v2/channels/${channel}?name=${encodeURIComponent(base64(name))}`;
  if (token) url += `&token=${encodeURIComponent(token)}`;
  return url;
}

export function isConfigComplete(cfg: TvConfig): boolean {
  if (!cfg.tvIp.trim()) return false;
  return cfg.mode === 'direct' || cfg.relayHost.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Outgoing messages

export function keyMessage(key: string, cmd: RemoteCmd = 'Click'): string {
  return JSON.stringify({
    method: 'ms.remote.control',
    params: { Cmd: cmd, DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
  });
}

export function launchAppMessage(appId: string, actionType: 'DEEP_LINK' | 'NATIVE_LAUNCH' = 'DEEP_LINK'): string {
  return JSON.stringify({
    method: 'ms.channel.emit',
    params: { event: 'ed.apps.launch', to: 'host', data: { action_type: actionType, appId, metaTag: '' } },
  });
}

export function installedAppsMessage(): string {
  return JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host' } });
}

/**
 * Experimental: some Tizen 9 sets open the 8002 socket silently and only show the
 * Allow prompt after the client sends a register frame (ha-samsungtv-smart #435).
 */
export function registerMessage(name: string = CLIENT_NAME, id: string = uuid()): string {
  return JSON.stringify({
    method: 'ms.channel.connect',
    params: { deviceName: base64(name), id, type: 'native', token: '' },
  });
}

/** Art-channel request. Note `data` is a JSON *string*, not an object. */
export function artRequestMessage(
  request: string,
  extra: Record<string, unknown> = {},
  requestId: string = uuid(),
): { message: string; requestId: string } {
  const inner = { request, ...extra, id: requestId, request_id: requestId };
  const message = JSON.stringify({
    method: 'ms.channel.emit',
    params: { event: 'art_app_request', to: 'host', data: JSON.stringify(inner) },
  });
  return { message, requestId };
}

// ---------------------------------------------------------------------------
// Incoming frames

export interface TvFrame {
  event: string;
  data: unknown;
  raw: string;
}

/** Events the TV sends right after connecting that carry no meaning for us. */
export const NOISE_EVENTS = new Set([
  'ms.edenTV.update',
  'ms.voiceApp.hide',
  'ms.remote.touchEnable',
  'ms.remote.touchDisable',
  'ms.remote.imeStart',
  'ms.remote.imeEnd',
]);

export const UNAUTHORIZED_EVENTS = new Set(['ms.channel.unauthorized', 'ms.channel.timeOut']);

export function parseFrame(raw: string): TvFrame | null {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.event !== 'string') return null;
    return { event: obj.event, data: obj.data, raw };
  } catch {
    return null;
  }
}

/** Token from an `ms.channel.connect` frame (`data.token`), if the TV issued one. */
export function tokenFromConnect(frame: TvFrame): string | null {
  const d = frame.data as { token?: unknown } | undefined;
  return d && typeof d.token === 'string' && d.token.length > 0 ? d.token : null;
}

/** Inner payload of an art-channel reply matching `requestId`, else null. */
export function parseArtReply(frame: TvFrame, requestId: string): Record<string, unknown> | null {
  if (frame.event !== 'd2d_service_message' || typeof frame.data !== 'string') return null;
  try {
    const inner = JSON.parse(frame.data);
    if (inner && (inner.request_id === requestId || inner.id === requestId)) return inner;
  } catch {
    // ignore malformed
  }
  return null;
}
