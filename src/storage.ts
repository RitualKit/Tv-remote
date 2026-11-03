import AsyncStorage from '@react-native-async-storage/async-storage';
import { TvApp, defaultApps, restoreApps } from './tv/apps';

const SETTINGS_KEY = 'frame-remote/settings/v1';

export interface Settings {
  tvIp: string;
  /** Pairing token the TV issued after "Allow". */
  token: string | null;
  /** SHA-256 of the TV's TLS certificate, pinned on first connect (trust on first use). */
  certSha256: string | null;
  /** App shortcut buttons, in display order. */
  apps: TvApp[];
  /** Dragging OK diagonally moves diagonally (alternating keys). */
  diagonalDrag: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  tvIp: '',
  token: null,
  certSha256: null,
  apps: defaultApps(),
  diagonalDrag: true,
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, apps: defaultApps() };
    const s = JSON.parse(raw);
    // Pick known keys only (drops v1's relay settings).
    return {
      tvIp: typeof s.tvIp === 'string' ? s.tvIp : '',
      token: typeof s.token === 'string' ? s.token : null,
      certSha256: typeof s.certSha256 === 'string' ? s.certSha256 : null,
      // Older installs have no saved list → the default four buttons.
      apps: restoreApps(s.apps) ?? defaultApps(),
      diagonalDrag: typeof s.diagonalDrag === 'boolean' ? s.diagonalDrag : true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, apps: defaultApps() };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
