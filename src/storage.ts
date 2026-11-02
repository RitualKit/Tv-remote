import AsyncStorage from '@react-native-async-storage/async-storage';
import { TvConfig } from './tv/protocol';

const SETTINGS_KEY = 'frame-remote/settings/v1';

export interface Settings extends TvConfig {
  token: string | null;
}

export const DEFAULT_SETTINGS: Settings = { tvIp: '', mode: 'relay', relayHost: '', token: null };

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
