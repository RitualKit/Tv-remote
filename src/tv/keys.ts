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
