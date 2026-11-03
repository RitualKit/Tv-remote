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
  clearTimer?: (handle: unknown) => void;
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
  clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}: HoldGestureOptions): HoldGesture {
  /** When the TV-side key went down; null while the key is up on the TV. */
  let pressedAt: number | null = null;
  /** Finger is down on a recognised hold (vs. lifted while a deferred Release is pending). */
  let fingerDown = false;
  /** Deferred Release from a hold that was lifted before `minHoldMs`. */
  let pendingRelease: unknown = null;

  const release = () => {
    pendingRelease = null;
    pressedAt = null;
    send('Release');
  };
  /** Send a deferred Release right now (keeps Press/Release strictly paired and ordered). */
  const flushPending = () => {
    if (pendingRelease === null) return;
    clearTimer(pendingRelease);
    release();
  };

  return {
    tap() {
      if (fingerDown) return;
      flushPending();
      send('Click');
    },
    holdStart() {
      if (fingerDown) return;
      fingerDown = true;
      if (pendingRelease !== null) {
        // Still held on the TV from the previous hold: cancel its Release and carry on as one
        // continuous hold instead of sending a second Press (and a Release mid-hold).
        clearTimer(pendingRelease);
        pendingRelease = null;
        return;
      }
      pressedAt = now();
      send('Press');
    },
    end() {
      if (!fingerDown) return;
      fingerDown = false;
      const wait = (pressedAt ?? now()) + minHoldMs - now();
      if (wait > 0) pendingRelease = setTimer(release, wait);
      else release();
    },
    get holding() {
      return fingerDown;
    },
  };
}

export interface RepeatGestureOptions {
  send: (cmd: HoldCmd) => void;
  /** Time between repeated clicks while held (≈ the physical remote's scroll speed). */
  intervalMs?: number;
  setRepeat?: (fn: () => void, ms: number) => unknown;
  clearRepeat?: (handle: unknown) => void;
}

export const DEFAULT_REPEAT_MS = 130;

/**
 * Tap vs. hold for direction keys: a tap is one `Click`; a hold repeats `Click` every
 * `intervalMs` until the finger lifts. Done in the app (like the volume rockers) rather than
 * relying on the TV to auto-repeat a held key, which not every firmware does over the network.
 */
export function createRepeatGesture({
  send,
  intervalMs = DEFAULT_REPEAT_MS,
  setRepeat = setInterval,
  clearRepeat = (h) => clearInterval(h as ReturnType<typeof setInterval>),
}: RepeatGestureOptions): HoldGesture {
  let handle: unknown = null;
  return {
    tap() {
      if (handle === null) send('Click');
    },
    holdStart() {
      if (handle !== null) return;
      send('Click');
      handle = setRepeat(() => send('Click'), intervalMs);
    },
    end() {
      if (handle === null) return;
      clearRepeat(handle);
      handle = null;
    },
    get holding() {
      return handle !== null;
    },
  };
}
