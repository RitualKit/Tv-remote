// The OK button as a small joystick (pure state machine; timers injectable for tests):
//  - finger stays put, lifts quickly  → OK tap
//  - finger stays put ≥ holdAfterMs   → OK press-and-hold (via the existing hold gesture)
//  - finger moves ≥ threshold         → one step in that direction (dominant axis), then
//                                       repeats while it stays out there
//  - finger comes back near centre    → repeating stops (hysteresis: half the threshold)
//  - finger moves to another side     → switches direction immediately
// Once a gesture has turned into a drag it never fires OK, and once OK is being held,
// movement is ignored, so the two can't mix.

import { HoldGesture } from './holdGesture';

export type Direction = 'up' | 'down' | 'left' | 'right';
export type JoystickMode = 'idle' | 'pending' | 'ok-hold' | 'drag';

export interface JoystickOptions {
  /** One step in a direction. `repeat` is false for the first step of a drag. */
  onDirection: (d: Direction, repeat: boolean) => void;
  /** OK handling for tap / hold (createHoldGesture). */
  ok: HoldGesture;
  onOkHoldStart?: () => void;
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

export function directionOf(dx: number, dy: number): Direction {
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
}

export function createJoystick({
  onDirection,
  ok,
  onOkHoldStart,
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
    onDirection(direction, true);
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
        const d = directionOf(dx, dy);
        if (d !== direction) {
          direction = d;
          stopRepeat();
          onDirection(d, false);
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
