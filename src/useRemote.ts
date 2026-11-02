import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { createTvSocket, isTvSocketAvailable } from '../modules/tv-socket';
import { ConnSnapshot, SamsungRemote } from './tv/SamsungRemote';
import { SocketFactory } from './tv/socket';
import { isConfigComplete } from './tv/protocol';
import { toggleArtMode } from './tv/art';
import { AppStatus, findInstalledId, launchAppRest } from './tv/rest';
import { KEYS } from './tv/keys';
import { InstalledApp, TvApp, parseInstalledApps, preferId } from './tv/apps';
import { DEFAULT_SETTINGS, Settings, loadSettings, saveSettings } from './storage';

const MAX_LOG = 40;
const TV_APPS_TIMEOUT_MS = 6_000;

/** The TV's own list of installed apps (`ed.installedApp.get`), if it answers. */
export type TvAppsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; apps: InstalledApp[] }
  | { phase: 'offline' }
  | { phase: 'unsupported' };

export function useRemote() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [conn, setConn] = useState<ConnSnapshot>({ status: 'idle' });
  const [log, setLog] = useState<string[]>([]);
  const remoteRef = useRef<SamsungRemote | null>(null);
  const [tvApps, setTvApps] = useState<TvAppsState>({ phase: 'idle' });
  const tvAppsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        if (event !== 'ed.installedApp.get') return;
        const apps = parseInstalledApps(data);
        if (tvAppsTimer.current) clearTimeout(tvAppsTimer.current);
        setTvApps(apps.length ? { phase: 'ready', apps } : { phase: 'unsupported' });
        addLog(`TV reported ${apps.length} installed apps`);
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
  /** Ask the TV for its installed apps; the answer arrives via onFrame (or never, on some TVs). */
  const loadTvApps = useCallback(() => {
    if (tvAppsTimer.current) clearTimeout(tvAppsTimer.current);
    if (!remoteRef.current?.requestInstalledApps()) {
      setTvApps({ phase: 'offline' }); // not connected; requestInstalledApps() starts a reconnect
      return;
    }
    setTvApps({ phase: 'loading' });
    tvAppsTimer.current = setTimeout(
      () => setTvApps((s) => (s.phase === 'loading' ? { phase: 'unsupported' } : s)),
      TV_APPS_TIMEOUT_MS,
    );
  }, []);
  useEffect(() => () => {
    if (tvAppsTimer.current) clearTimeout(tvAppsTimer.current);
  }, []);

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

  /** Replace the app-button list (add / remove / reorder in the editor). */
  const setApps = useCallback((apps: TvApp[]) => patchSettings({ apps }), [patchSettings]);

  /**
   * Ask the TV whether `app` is installed. If one of its IDs is confirmed, that ID moves first
   * (and is saved, if the app is already a button) so launches use it directly.
   */
  const checkApp = useCallback(
    async (app: TvApp): Promise<{ status: AppStatus; app: TvApp }> => {
      const tvIp = settingsRef.current.tvIp;
      if (!tvIp) return { status: 'unknown', app };
      const { status, id } = await findInstalledId({ tvIp }, app.ids);
      if (status !== 'installed' || !id) return { status, app };
      const updated = preferId(app, id);
      const list = settingsRef.current.apps;
      if (updated !== app && list.some((a) => a.key === app.key)) {
        patchSettings({ apps: list.map((a) => (a.key === app.key ? preferId(a, id) : a)) });
      }
      return { status, app: updated };
    },
    [patchSettings],
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
    loadTvApps,
    tvApps,
    setApps,
    checkApp,
  };
}
