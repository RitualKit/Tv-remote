import { TvConfig, httpBase } from './protocol';

export interface DeviceInfo {
  name?: string;
  modelName?: string;
  frameTv?: boolean;
  tokenAuth?: boolean;
  powerState?: string;
  os?: string;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 4_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** GET /api/v2/ — works without pairing; good "is the TV reachable?" check. */
export async function getDeviceInfo(cfg: TvConfig): Promise<DeviceInfo> {
  const res = await fetchWithTimeout(`${httpBase(cfg)}/api/v2/`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const d = json?.device ?? {};
  return {
    name: d.name ?? json?.name,
    modelName: d.modelName,
    frameTv: String(d.FrameTVSupport) === 'true',
    tokenAuth: String(d.TokenAuthSupport) === 'true',
    powerState: d.PowerState,
    os: d.OS,
  };
}

/** REST app launch. Fire-and-forget: many 2022+ sets ignore it, some only honour this. */
export async function launchAppRest(cfg: TvConfig, appId: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${httpBase(cfg)}/api/v2/applications/${encodeURIComponent(appId)}`, {
      method: 'POST',
    });
    return res.ok;
  } catch {
    return false;
  }
}
