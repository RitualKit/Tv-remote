// Pure helpers for the Samsung Tizen "ms.*" WebSocket protocol.
// No React, no network: everything here can be unit-tested in Node.

export const CLIENT_NAME = 'FrameRemote';

/** 2022+ Frames only accept remote control over TLS on 8002 (self-signed cert). */
export const TV_WSS_PORT = 8002;
/** Plain HTTP REST (device info, app launch) still answers on 8001. */
export const TV_HTTP_PORT = 8001;

export interface TvConfig {
  tvIp: string;
  /** Overrides for tests only; the real TV always uses 8002 / 8001. */
  wssPort?: number;
  httpPort?: number;
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

export function wsBase(cfg: TvConfig): string {
  return `wss://${cfg.tvIp.trim()}:${cfg.wssPort ?? TV_WSS_PORT}`;
}

export function httpBase(cfg: TvConfig): string {
  return `http://${cfg.tvIp.trim()}:${cfg.httpPort ?? TV_HTTP_PORT}`;
}

/**
 * True for 10/8, 172.16/12 and 192.168/16 addresses. The native socket only skips certificate
 * checks for these, so the trust override can never apply to an internet host.
 */
export function isPrivateIPv4(host: string): boolean {
  const m = host.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
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
  return cfg.tvIp.trim().length > 0;
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
