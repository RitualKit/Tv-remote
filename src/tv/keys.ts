// Samsung Tizen remote key codes (as used by samsungtvws and the TV's own SmartView protocol).
export const KEYS = {
  power: 'KEY_POWER',

  up: 'KEY_UP',
  down: 'KEY_DOWN',
  left: 'KEY_LEFT',
  right: 'KEY_RIGHT',
  ok: 'KEY_ENTER',

  back: 'KEY_RETURN',
  home: 'KEY_HOME',
  menu: 'KEY_MENU',
  source: 'KEY_SOURCE',
  info: 'KEY_INFO',
  guide: 'KEY_GUIDE',

  volUp: 'KEY_VOLUP',
  volDown: 'KEY_VOLDOWN',
  mute: 'KEY_MUTE',

  chUp: 'KEY_CHUP',
  chDown: 'KEY_CHDOWN',
  chList: 'KEY_CH_LIST',
} as const;

export const digitKey = (d: number) => `KEY_${d}`;

export interface TvApp {
  name: string;
  /** Tried in order; IDs differ between model years/regions. */
  ids: string[];
  color: string;
}

// Netflix/YouTube IDs are widely confirmed; Prime Video / Disney+ are community-reported
// and should be checked against `ed.installedApp.get` output (see `npm run probe -- <ip> --apps`).
export const APPS: TvApp[] = [
  { name: 'Netflix', ids: ['3201907018807', '11101200001'], color: '#E50914' },
  { name: 'YouTube', ids: ['111299001912'], color: '#FF0033' },
  { name: 'Prime', ids: ['3201910019365', '3201512006785'], color: '#00A8E1' },
  { name: 'Disney+', ids: ['3201901017640'], color: '#113CCF' },
];
