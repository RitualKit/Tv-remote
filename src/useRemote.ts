import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ConnSnapshot, SamsungRemote } from './tv/SamsungRemote';
import { isConfigComplete } from './tv/protocol';
import { toggleArtMode } from './tv/art';
import { launchAppRest } from './tv/rest';
import { KEYS, TvApp } from './tv/keys';
import { DEFAULT_SETTINGS, Settings, loadSettings, saveSettings } from './storage';

const MAX_LOG = 40;

export function useRemote() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [conn, setConn] = useState<ConnSnapshot>({ status: 'idle' });
  const [log, setLog] = useState<string[]>([]);
  const remoteRef = useRef<SamsungRemote | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const addLog = useCallback((line: string) => {
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    setLog((l) => [`${ts} ${line}`, ...l].slice(0, MAX_LOG));
  }, []);

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  // (Re)create the connection whenever the TV address / transport changes.
  const { tvIp, mode, relayHost } = settings;
  useEffect(() => {
    if (!loaded) return;
    const cfg = { tvIp, mode, relayHost };
    if (!isConfigComplete(cfg)) {
      setConn({ status: 'idle', message: 'Set the TV IP in settings.' });
      return;
    }
    const remote = new SamsungRemote({
      config: cfg,
      token: settingsRef.current.token,
      onStatus: (s) => {
        setConn(s);
        if (s.status === 'connected') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      },
      onToken: (token) => {
        const next = { ...settingsRef.current, token };
        setSettings(next);
        saveSettings(next).catch(() => {});
      },
      onLog: addLog,
      onFrame: (event, data) => {
        if (event === 'ed.installedApp.get') addLog(`apps: ${JSON.stringify(data).slice(0, 400)}`);
      },
    });
    remoteRef.current = remote;
    if (AppState.currentState === 'active') remote.connect();
    return () => {
      remote.disconnect();
      if (remoteRef.current === remote) remoteRef.current = null;
    };
  }, [loaded, tvIp, mode, relayHost, addLog]);

  // Reconnect when returning to the app; drop the socket in the background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const r = remoteRef.current;
      if (!r) return;
      if (state === 'active') r.connect();
      else if (state === 'background') r.disconnect();
    });
    return () => sub.remove();
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const prev = settingsRef.current;
    const next = { ...prev, ...patch };
    // A different TV invalidates the pairing token.
    if (next.tvIp.trim() !== prev.tvIp.trim()) next.token = null;
    const addressChanged = next.tvIp !== prev.tvIp || next.mode !== prev.mode || next.relayHost !== prev.relayHost;
    setSettings(next);
    await saveSettings(next);
    // Address changes recreate the connection via the effect above; otherwise retry now
    // (e.g. "Save & connect" after fixing Wi-Fi or approving on the TV).
    if (!addressChanged && 'tvIp' in patch) remoteRef.current?.reconnect();
  }, []);

  const forgetPairing = useCallback(async () => {
    await updateSettings({ token: null });
    remoteRef.current?.forgetToken();
  }, [updateSettings]);

  const key = useCallback((k: string) => remoteRef.current?.sendKey(k) ?? false, []);
  const holdKey = useCallback((k: string, ms: number) => remoteRef.current?.holdKey(k, ms) ?? false, []);
  const reconnect = useCallback(() => remoteRef.current?.reconnect(), []);
  const requestApps = useCallback(() => remoteRef.current?.requestInstalledApps(), []);

  const launch = useCallback(
    async (app: TvApp) => {
      const r = remoteRef.current;
      if (!r) return;
      const cfg = settingsRef.current;
      // Both paths are fire-and-forget; send WS launch and REST launch for the primary ID,
      // then try REST for alternates only if the first REST call was rejected (404 = unknown id).
      r.launchApp(app.ids[0]);
      addLog(`launch ${app.name}`);
      for (const id of app.ids) {
        if (await launchAppRest(cfg, id)) return;
      }
    },
    [addLog],
  );

  const toggleArt = useCallback(async () => {
    const cfg = settingsRef.current;
    try {
      const next = await toggleArtMode(cfg);
      addLog(`art mode → ${next}`);
    } catch (e) {
      // Art API missing/silent on this firmware: on The Frame a short power press toggles Art ↔ TV.
      addLog(`art API failed (${(e as Error).message}); sending KEY_POWER`);
      remoteRef.current?.sendKey(KEYS.power);
    }
  }, [addLog]);

  return {
    loaded,
    settings,
    conn,
    log,
    updateSettings,
    forgetPairing,
    key,
    holdKey,
    reconnect,
    launch,
    toggleArt,
    requestApps,
  };
}
