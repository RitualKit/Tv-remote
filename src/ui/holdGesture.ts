// Tap vs. hold for a remote button, the way Samsung's physical remote does it:
//  - tap  → one `Click`
//  - hold → `Press` when the hold is recognised, `Release` when the finger lifts.
//    The TV measures the hold itself (e.g. OK held on an app tile opens Move/Remove;
//    an arrow held scrolls continuously).
// The Release is delayed to at least `minHoldMs` after the Press, so a hold that the app
// recognised is always long enough for the TV to treat as one.
//
// Pure: timers and clock are injectable, so this is unit-tested in Node.

export type HoldCmd = 'Click' | 'Press' | 'Release';

export interface HoldGestureOptions {
  send: (cmd: HoldCmd) => void;
  minHoldMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export interface HoldGesture {
  /** Finger lifted before the long-press delay: a normal tap. */
  tap(): void;
  /** Long-press delay reached while still pressed. */
  holdStart(): void;
  /** Finger lifted (after a tap or a hold). Safe to call more than once. */
  end(): void;
  readonly holding: boolean;
}

export const DEFAULT_MIN_HOLD_MS = 1_000;

export function createHoldGesture({
  send,
  minHoldMs = DEFAULT_MIN_HOLD_MS,
  now = Date.now,
  setTimer = setTimeout,
}: HoldGestureOptions): HoldGesture {
  let pressedAt: number | null = null;
  return {
    tap() {
      if (pressedAt === null) send('Click');
    },
    holdStart() {
      if (pressedAt !== null) return;
      pressedAt = now();
      send('Press');
    },
    end() {
      if (pressedAt === null) return;
      const wait = pressedAt + minHoldMs - now();
      pressedAt = null;
      if (wait > 0) setTimer(() => send('Release'), wait);
      else send('Release');
    },
    get holding() {
      return pressedAt !== null;
    },
  };
}
