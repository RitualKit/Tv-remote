// The OK button as a small joystick (pure state machine; timers injectable for tests):
//  - finger stays put, lifts quickly  → OK tap
//  - finger stays put ≥ holdAfterMs   → OK press-and-hold (via the existing hold gesture)
//  - finger moves ≥ threshold         → one step in that direction, then repeats while it
//                                       stays out there
//  - finger comes back near centre    → repeating stops (hysteresis: half the threshold)
//  - finger moves to another side     → switches direction immediately
// Diagonals (optional): Samsung TVs only have four direction keys, so a diagonal is
// imitated. Its first step sends both keys (vertical, then horizontal); repeats alternate.
// Once a gesture has turned into a drag it never fires OK, and once OK is being held,
// movement is ignored, so the two can't mix.

import { HoldGesture } from './holdGesture';

export type Cardinal = 'up' | 'down' | 'left' | 'right';
export type Diagonal = 'up-left' | 'up-right' | 'down-left' | 'down-right';
export type Direction = Cardinal | Diagonal;
export type JoystickMode = 'idle' | 'pending' | 'ok-hold' | 'drag';

export interface JoystickOptions {
  /** One key step. `repeat` is false for the step(s) sent when a direction starts. */
  onDirection: (d: Cardinal, repeat: boolean) => void;
  /** OK handling for tap / hold (createHoldGesture). */
  ok: HoldGesture;
  onOkHoldStart?: () => void;
  /** Read at each move, so the setting can change without recreating the joystick. */
  diagonal?: () => boolean;
  /** Distance (px) the finger must travel before it counts as a drag. */
  threshold?: number;
  holdAfterMs?: number;
  repeatDelayMs?: number;
  repeatEveryMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Joystick {
  /** Finger down on the button. */
  start(): void;
  /** Finger moved; offset from where it went down. */
  move(dx: number, dy: number): void;
  /** Finger lifted. */
  end(): void;
  /** Gesture taken away by the system: like end, but never counts as an OK tap. */
  cancel(): void;
  readonly mode: JoystickMode;
  readonly direction: Direction | null;
}

export const DRAG_THRESHOLD_PX = 28;
/** Half-width of a diagonal's zone around 45°/135°/…; the cardinal zones get the rest (±25°). */
export const DIAGONAL_HALF_WIDTH_DEG = 20;
/** Once a direction is chosen, the finger must go this far past its zone edge to change it. */
export const SWITCH_HYSTERESIS_DEG = 8;

/** Screen angle in degrees: 0 = right, 90 = up (dy is positive downwards). */
const CENTRE: Record<Direction, number> = {
  right: 0,
  'up-right': 45,
  up: 90,
  'up-left': 135,
  left: 180,
  'down-left': 225,
  down: 270,
  'down-right': 315,
};
const DIAGONALS: Diagonal[] = ['up-right', 'up-left', 'down-left', 'down-right'];

const angleOf = (dx: number, dy: number) => (Math.atan2(-dy, dx) * 180) / Math.PI;
const angDist = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
const isDiagonal = (d: Direction): d is Diagonal => d.includes('-');

/** Half-width of a direction's zone, given whether diagonals are on. */
function halfWidth(d: Direction, diagonal: boolean): number {
  if (isDiagonal(d)) return DIAGONAL_HALF_WIDTH_DEG;
  return diagonal ? 45 - DIAGONAL_HALF_WIDTH_DEG : 45;
}

/** The keys a direction sends, vertical first: 'up-right' → ['up', 'right']. */
export function keysFor(d: Direction): Cardinal[] {
  return isDiagonal(d) ? (d.split('-') as Cardinal[]) : [d];
}

/**
 * Which direction a drag points, without hysteresis. Exactly on a cardinal boundary the
 * vertical one wins (as before diagonals existed).
 */
export function directionOf(dx: number, dy: number, diagonal = false): Direction {
  const a = angleOf(dx, dy);
  if (diagonal) {
    for (const d of DIAGONALS) if (angDist(a, CENTRE[d]) <= DIAGONAL_HALF_WIDTH_DEG) return d;
  }
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}

export function createJoystick({
  onDirection,
  ok,
  onOkHoldStart,
  diagonal = () => false,
  threshold = DRAG_THRESHOLD_PX,
  holdAfterMs = 400,
  repeatDelayMs = 350,
  repeatEveryMs = 130,
  setTimer = setTimeout,
  clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}: JoystickOptions): Joystick {
  let mode: JoystickMode = 'idle';
  let direction: Direction | null = null;
  let holdTimer: unknown = null;
  let repeatTimer: unknown = null;
  /** Which of a diagonal's two keys the next repeat sends. */
  let alternate = 0;

  const stopHoldTimer = () => {
    if (holdTimer !== null) clearTimer(holdTimer);
    holdTimer = null;
  };
  const stopRepeat = () => {
    if (repeatTimer !== null) clearTimer(repeatTimer);
    repeatTimer = null;
  };
  const tick = () => {
    if (mode !== 'drag' || direction === null) return;
    const keys = keysFor(direction);
    onDirection(keys[alternate % keys.length], true);
    alternate++;
    repeatTimer = setTimer(tick, repeatEveryMs);
  };
  const finish = (asTap: boolean) => {
    stopHoldTimer();
    stopRepeat();
    if (mode === 'pending' && asTap) ok.tap();
    if (mode === 'ok-hold') ok.end();
    mode = 'idle';
    direction = null;
  };
  /** Keep the current direction unless the finger is clearly past its zone. */
  const pick = (dx: number, dy: number): Direction => {
    const diag = diagonal();
    if (direction !== null && (diag || !isDiagonal(direction))) {
      const keep = halfWidth(direction, diag) + SWITCH_HYSTERESIS_DEG;
      if (angDist(angleOf(dx, dy), CENTRE[direction]) <= keep) return direction;
    }
    return directionOf(dx, dy, diag);
  };

  return {
    start() {
      if (mode !== 'idle') finish(false);
      mode = 'pending';
      holdTimer = setTimer(() => {
        holdTimer = null;
        if (mode !== 'pending') return;
        mode = 'ok-hold';
        ok.holdStart();
        onOkHoldStart?.();
      }, holdAfterMs);
    },
    move(dx, dy) {
      if (mode === 'idle' || mode === 'ok-hold') return;
      const dist = Math.hypot(dx, dy);
      if (mode === 'pending') {
        if (dist < threshold) return;
        stopHoldTimer();
        mode = 'drag';
      }
      if (dist >= threshold) {
        const d = pick(dx, dy);
        if (d !== direction) {
          direction = d;
          stopRepeat();
          for (const k of keysFor(d)) onDirection(k, false);
          alternate = 0;
          repeatTimer = setTimer(tick, repeatDelayMs);
        }
      } else if (dist < threshold / 2 && direction !== null) {
        direction = null;
        stopRepeat();
      }
    },
    end() {
      finish(true);
    },
    cancel() {
      finish(false);
    },
    get mode() {
      return mode;
    },
    get direction() {
      return direction;
    },
  };
}

