import { useCallback, useEffect, useRef, useState } from 'react';
import * as Network from 'expo-network';
import { FoundTv, httpProbe, scanForTvs, sortTvs, subnetCandidates, subnetLabel } from './tv/discovery';

export type ScanState =
  | { phase: 'idle' }
  | { phase: 'scanning'; subnet: string; done: number; total: number }
  | { phase: 'done'; subnet: string }
  | { phase: 'error'; message: string };

/** Scans the phone's Wi-Fi /24 for Samsung TVs. */
export function useTvScan() {
  const [state, setState] = useState<ScanState>({ phase: 'idle' });
  const [tvs, setTvs] = useState<FoundTv[]>([]);
  const runId = useRef(0);

  const cancel = useCallback(() => {
    runId.current++;
    setState((s) => (s.phase === 'scanning' ? { phase: 'idle' } : s));
  }, []);
  useEffect(() => () => void runId.current++, []);

  const scan = useCallback(async (): Promise<FoundTv[]> => {
    const id = ++runId.current;
    const cancelled = () => runId.current !== id;
    setTvs([]);

    let phoneIp = '0.0.0.0';
    try {
      phoneIp = await Network.getIpAddressAsync();
    } catch {
      // handled below
    }
    if (cancelled()) return [];
    const candidates = subnetCandidates(phoneIp);
    if (candidates.length === 0) {
      setState({ phase: 'error', message: 'Connect your iPhone to your home Wi-Fi, then scan again.' });
      return [];
    }

    const subnet = subnetLabel(phoneIp);
    setState({ phase: 'scanning', subnet, done: 0, total: candidates.length });
    const found = await scanForTvs(candidates, httpProbe(), {
      isCancelled: cancelled,
      onFound: (tv) => setTvs((list) => sortTvs([...list, tv])),
      onProgress: (done, total) => setState({ phase: 'scanning', subnet, done, total }),
    });
    if (cancelled()) return [];
    setState({ phase: 'done', subnet });
    return found;
  }, []);

  return { state, tvs, scan, cancel };
}
