// Finds Samsung TVs on the phone's Wi-Fi by asking every address in its /24 subnet for the
// TV's device description (GET http://<ip>:8001/api/v2/). Plain one-to-one HTTP, so it works
// without the multicast entitlement that SSDP/UPnP discovery would need on iOS.
//
// Pure TypeScript: the phone's IP and the probe are passed in, so this is testable in Node.

import { DeviceInfo, getDeviceInfo } from './rest';
import { isPrivateIPv4 } from './protocol';

export interface FoundTv extends DeviceInfo {
  ip: string;
}

export type Probe = (ip: string) => Promise<DeviceInfo | null>;

/** All other host addresses in the phone's /24 (x.y.z.1–254), or [] if not on a private LAN. */
export function subnetCandidates(phoneIp: string): string[] {
  if (!isPrivateIPv4(phoneIp)) return [];
  const [a, b, c, d] = phoneIp.split('.').map(Number);
  const out: string[] = [];
  for (let host = 1; host <= 254; host++) if (host !== d) out.push(`${a}.${b}.${c}.${host}`);
  return out;
}

/** e.g. "192.168.1.x" for display. */
export function subnetLabel(phoneIp: string): string {
  return phoneIp.split('.').slice(0, 3).join('.') + '.x';
}

/** Probe one address: device info if a Samsung TV answers quickly, else null. */
export function httpProbe(timeoutMs = 900, httpPort?: number): Probe {
  return async (ip) => {
    try {
      return await getDeviceInfo({ tvIp: ip, httpPort }, timeoutMs);
    } catch {
      return null;
    }
  };
}

export interface ScanOptions {
  /** Parallel probes. Most addresses are empty and only cost a timeout. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  onFound?: (tv: FoundTv) => void;
  /** Return true to stop early (e.g. the settings sheet was closed). */
  isCancelled?: () => boolean;
}

/** Frames first, then by address. */
export function sortTvs(tvs: FoundTv[]): FoundTv[] {
  const last = (ip: string) => Number(ip.split('.').pop());
  return [...tvs].sort((x, y) => Number(!!y.frameTv) - Number(!!x.frameTv) || last(x.ip) - last(y.ip));
}

export async function scanForTvs(candidates: string[], probe: Probe, opts: ScanOptions = {}): Promise<FoundTv[]> {
  const { concurrency = 32, onProgress, onFound, isCancelled } = opts;
  const found: FoundTv[] = [];
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (next < candidates.length && !isCancelled?.()) {
      const ip = candidates[next++];
      const info = await probe(ip);
      done++;
      if (isCancelled?.()) return;
      if (info) {
        const tv = { ...info, ip };
        found.push(tv);
        onFound?.(tv);
      }
      onProgress?.(done, candidates.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return sortTvs(found);
}
