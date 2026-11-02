import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { createTvSocket, isTvSocketAvailable } from '../modules/tv-socket';
import { ConnSnapshot, SamsungRemote } from './tv/SamsungRemote';
import { SocketFactory } from './tv/socket';
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

  const addLog = useCallback((line: string) => {
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    setLog((l) => [`${ts} ${line}`, ...l].slice(0, MAX_LOG));
  }, []);

  /** Apply a settings patch synchronously to the ref (so back-to-back patches don't race) and persist. */
  const patchSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    return saveSettings(next).catch(() => {});
  }, []);

  useEffect(() => {
    loadSettings().then((s) => {
      settingsRef.current = s;
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  /** Native TLS socket, pinned to the TV's certificate after the first successful connect. */
  const createSocket = useCallback<SocketFactory>(
    (url) =>
      createTvSocket(url, {
        pinnedSha256: settingsRef.current.certSha256,
        onCertificate: (sha256) => {
          if (settingsRef.current.certSha256) return;
          patchSettings({ certSha256: sha256 });
          addLog(`TV certificate pinned (${sha256.slice(0, 12)}…)`);
        },
      }),
    [patchSettings, addLog],
  );

  // (Re)create the connection whenever the TV address changes.
  const { tvIp } = settings;
  useEffect(() => {
    if (!loaded) return;
    if (!isTvSocketAvailable) {
      setConn({ status: 'error', message: 'Native socket missing: run the sideloaded Frame Remote build, not Expo Go.' });
      return;
    }
    if (!isConfigComplete({ tvIp })) {
      setConn({ status: 'idle', message: 'Set the TV IP in settings.' });
      return;
    }
    const remote = new SamsungRemote({
      config: { tvIp },
      token: settingsRef.current.token,
      createSocket,
      onStatus: (s) => {
        setConn(s);
        if (s.status === 'connected') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      },
      onToken: (token) => {
        patchSettings({ token });
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
  }, [loaded, tvIp, createSocket, patchSettings, addLog]);

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

  /** Save a new TV IP. A different TV invalidates the pairing token and pinned certificate. */
  const saveTvIp = useCallback(
    async (ip: string) => {
      const next = ip.trim();
      if (next !== settingsRef.current.tvIp) {
        await patchSettings({ tvIp: next, token: null, certSha256: null }); // effect reconnects
      } else {
        remoteRef.current?.reconnect(); // "Save & connect" with the same IP = retry now
      }
    },
    [patchSettings],
  );

  const forgetPairing = useCallback(async () => {
    await patchSettings({ token: null });
    remoteRef.current?.forgetToken();
  }, [patchSettings]);

  const resetCertificate = useCallback(async () => {
    await patchSettings({ certSha256: null });
    addLog('TV certificate pin cleared; next connect pins the current one');
    remoteRef.current?.reconnect();
  }, [patchSettings, addLog]);

  const key = useCallback((k: string) => remoteRef.current?.sendKey(k) ?? false, []);
  const holdKey = useCallback((k: string, ms: number) => remoteRef.current?.holdKey(k, ms) ?? false, []);
  const reconnect = useCallback(() => remoteRef.current?.reconnect(), []);
  const requestApps = useCallback(() => remoteRef.current?.requestInstalledApps(), []);

  const launch = useCallback(
    async (app: TvApp) => {
      const r = remoteRef.current;
      if (!r) return;
      // Both paths are fire-and-forget; send the WS launch plus REST, trying alternate IDs over
      // REST only when the TV rejects the previous one (404 = unknown id).
      r.launchApp(app.ids[0]);
      addLog(`launch ${app.name}`);
      for (const id of app.ids) {
        if (await launchAppRest({ tvIp: settingsRef.current.tvIp }, id)) return;
      }
    },
    [addLog],
  );

  const toggleArt = useCallback(async () => {
    try {
      const next = await toggleArtMode({ tvIp: settingsRef.current.tvIp }, createSocket);
      addLog(`art mode → ${next}`);
    } catch (e) {
      // Art API missing/silent on this firmware: on The Frame a short power press toggles Art ↔ TV.
      addLog(`art API failed (${(e as Error).message}); sending KEY_POWER`);
      remoteRef.current?.sendKey(KEYS.power);
    }
  }, [addLog, createSocket]);

  return {
    loaded,
    settings,
    conn,
    log,
    saveTvIp,
    forgetPairing,
    resetCertificate,
    key,
    holdKey,
    reconnect,
    launch,
    toggleArt,
    requestApps,
  };
}
