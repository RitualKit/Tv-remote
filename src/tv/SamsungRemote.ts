import {
  CLIENT_NAME,
  NOISE_EVENTS,
  REMOTE_CHANNEL,
  RemoteCmd,
  TvConfig,
  UNAUTHORIZED_EVENTS,
  channelUrl,
  installedAppsMessage,
  keyMessage,
  launchAppMessage,
  parseFrame,
  registerMessage,
  tokenFromConnect,
} from './protocol';
import { SocketFactory, SocketLike } from './socket';

export type ConnStatus = 'idle' | 'connecting' | 'awaitingAllow' | 'connected' | 'unauthorized' | 'error';

export interface ConnSnapshot {
  status: ConnStatus;
  message?: string;
}

export interface SamsungRemoteOptions {
  config: TvConfig;
  token: string | null;
  createSocket: SocketFactory;
  onStatus: (s: ConnSnapshot) => void;
  onToken: (token: string | null) => void;
  onLog?: (line: string) => void;
  onFrame?: (event: string, data: unknown) => void;
  /** Clock, injectable for tests. */
  now?: () => number;
}

const OPEN_TIMEOUT_MS = 8_000; // socket must open within this
const ALLOW_TIMEOUT_MS = 30_000; // user has this long to press Allow on the TV
const REGISTER_AFTER_MS = 3_000; // silent socket → send the experimental register frame
/** First retry almost at once (most drops are momentary), then back off. */
export const BACKOFF_MS = [250, 1_000, 2_000, 4_000, 8_000, 10_000];
/** Keys pressed while (re)connecting are sent once connected if they are at most this old. */
export const QUEUE_WINDOW_MS = 2_000;
const QUEUE_MAX = 12;
/** On returning to the app, how long to wait for the kept connection to answer a ping. */
export const RESUME_PING_TIMEOUT_MS = 1_000;

interface Pending {
  msg: string;
  at: number;
  key?: string;
  cmd?: RemoteCmd;
  /** holdKey(): send the Release this long after the Press actually goes out. */
  holdMs?: number;
}

/**
 * One persistent connection to the TV's remote-control channel.
 * - Reconnects with backoff until disconnect() is called or the TV refuses us.
 * - Survives the app going to the background: suspend()/resume() keep the socket and, on
 *   return, ping it; if it's dead, reconnect at once.
 * - Keys pressed while (re)connecting or verifying are queued for QUEUE_WINDOW_MS and sent as
 *   soon as the link is ready; older ones are dropped so nothing fires unexpectedly later.
 */
export class SamsungRemote {
  private ws: SocketLike | null = null;
  private generation = 0; // ignores events from sockets we've already replaced
  private wanted = false; // true between connect() and disconnect()
  private attempt = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: ConnSnapshot = { status: 'idle' };
  private token: string | null;
  private pending: Pending[] = [];
  /** True while a resumed connection is being pinged; keys queue meanwhile. */
  private verifying = false;
  /** Queued keys still being replayed (with their original spacing); new keys wait behind them. */
  private replayLeft = 0;
  /**
   * Keys whose Press went out late from the queue, by how much. Their live Release is delayed by
   * the same amount, so the TV sees exactly the hold the user made.
   */
  private pressDelay = new Map<string, number>();
  private openedAt = 0;
  private suspendedAt: number | null = null;
  private readonly now: () => number;

  constructor(private opts: SamsungRemoteOptions) {
    this.token = opts.token;
    this.now = opts.now ?? Date.now;
  }

  get status(): ConnStatus {
    return this.snapshot.status;
  }

  get isConnected(): boolean {
    return this.snapshot.status === 'connected';
  }

  /** Start (or restart) connecting. Safe to call repeatedly. */
  connect(): void {
    this.wanted = true;
    if (this.ws && (this.status === 'connected' || this.status === 'connecting' || this.status === 'awaitingAllow')) {
      return;
    }
    this.clearRetry();
    this.open();
  }

  /** Force a fresh socket now, resetting backoff (e.g. user tapped the status pill). */
  reconnect(): void {
    this.attempt = 0;
    this.teardown();
    this.wanted = true;
    this.clearRetry();
    this.open();
  }

  /** Drop the stored token and pair again (the TV will show the Allow prompt). */
  forgetToken(): void {
    this.token = null;
    this.reconnect();
  }

  disconnect(): void {
    this.wanted = false;
    this.pending = [];
    this.clearRetry();
    this.teardown();
    this.setStatus({ status: 'idle' });
  }

  /** The app went to the background. The connection is kept (see resume). */
  suspend(): void {
    this.suspendedAt = this.now();
  }

  /**
   * The app is in the foreground again. If the kept connection still answers a ping, carry on
   * instantly; if not (TV slept, Wi-Fi changed), reconnect right away instead of waiting.
   */
  resume(): void {
    this.wanted = true;
    const away = this.suspendedAt === null ? null : this.now() - this.suspendedAt;
    this.suspendedAt = null;
    const awayText = away === null ? '' : ` after ${(away / 1000).toFixed(1)}s`;
    const ws = this.ws;
    if (ws && this.isConnected) {
      if (!ws.checkAlive) return;
      const gen = this.generation;
      const t0 = this.now();
      this.verifying = true;
      const settle = (alive: boolean) => {
        if (gen !== this.generation) return;
        this.verifying = false;
        if (alive) {
          this.log(`back${awayText}: connection still alive (${this.now() - t0} ms)`);
          this.flushPending();
        } else {
          this.log(`back${awayText}: connection gone → reconnecting`);
          this.reconnect();
        }
      };
      ws.checkAlive(RESUME_PING_TIMEOUT_MS).then(settle, () => settle(false));
      return;
    }
    if (this.status === 'connecting' || this.status === 'awaitingAllow') return;
    if (awayText) this.log(`back${awayText}: reconnecting now`);
    this.reconnect();
  }

  /**
   * Sends now if connected; otherwise starts connecting and queues the key (see
   * QUEUE_WINDOW_MS). Returns false only if the key was not accepted.
   */
  sendKey(key: string, cmd: RemoteCmd = 'Click'): boolean {
    return this.sendRaw(keyMessage(key, cmd), { key, cmd });
  }

  /** Press, hold for `ms`, release. Used for long-press power (full off on The Frame). */
  holdKey(key: string, ms: number): boolean {
    if (this.canSendNow()) {
      this.ws!.send(keyMessage(key, 'Press'));
      setTimeout(() => this.sendKey(key, 'Release'), ms);
      return true;
    }
    // Not connected yet: the hold is timed from when the Press actually reaches the TV.
    return this.sendRaw(keyMessage(key, 'Press'), { key, cmd: 'Press', holdMs: ms });
  }

  launchApp(appId: string): boolean {
    return this.sendRaw(launchAppMessage(appId), {});
  }

  /** Reply arrives via onFrame as event 'ed.installedApp.get'. Not supported on every model. */
  requestInstalledApps(): boolean {
    return this.sendRaw(installedAppsMessage(), false);
  }

  // -------------------------------------------------------------------------

  private canSendNow(): boolean {
    return !!this.ws && this.isConnected && !this.verifying && this.replayLeft === 0;
  }

  /** `queue`: false = never queue (the caller handles "not connected"). */
  private sendRaw(msg: string, queue: { key?: string; cmd?: RemoteCmd; holdMs?: number } | false): boolean {
    if (this.canSendNow()) {
      const delay = queue && queue.cmd === 'Release' && queue.key ? this.pressDelay.get(queue.key) : undefined;
      if (delay !== undefined && queue && queue.key) {
        this.pressDelay.delete(queue.key);
        const gen = this.generation;
        setTimeout(() => {
          if (gen === this.generation && this.ws && this.isConnected) this.ws.send(msg);
        }, delay);
        return true;
      }
      this.ws!.send(msg);
      return true;
    }
    if (this.ws && this.isConnected && !this.verifying) {
      // Connected, but a replay of queued keys is in progress: wait behind it to keep order.
      if (queue === false) {
        this.ws.send(msg);
        return true;
      }
      this.pending.push({ msg, at: this.now(), ...queue });
      return true;
    }
    if (!this.verifying) this.connect();
    if (queue === false) return false;
    this.pending.push({ msg, at: this.now(), ...queue });
    if (this.pending.length > QUEUE_MAX) this.pending.splice(0, this.pending.length - QUEUE_MAX);
    return true;
  }

  /**
   * Replay queued keys that are still fresh, keeping their original spacing (so a queued hold
   * stays a hold for as long as the user held it). A Release whose Press was dropped is dropped
   * too. Keys arriving during the replay are queued behind it and flushed when it finishes.
   */
  private flushPending(): void {
    if (!this.ws || this.pending.length === 0 || this.replayLeft > 0) return;
    const cutoff = this.now() - QUEUE_WINDOW_MS;
    const items = this.pending;
    this.pending = [];
    const droppedPress = new Set<string>();
    const fresh: Pending[] = [];
    let dropped = 0;
    for (const p of items) {
      if (p.at < cutoff) {
        dropped++;
        if (p.key && p.cmd === 'Press') droppedPress.add(p.key);
        continue;
      }
      if (p.key && p.cmd === 'Release' && droppedPress.has(p.key)) {
        droppedPress.delete(p.key);
        dropped++;
        continue;
      }
      if (p.key && p.cmd === 'Press') droppedPress.delete(p.key);
      fresh.push(p);
    }
    this.log(`sending ${fresh.length} queued key${fresh.length === 1 ? '' : 's'}${dropped ? `, dropped ${dropped} stale` : ''}`);
    if (fresh.length === 0) return;

    const gen = this.generation;
    const base = fresh[0].at;
    this.replayLeft = fresh.length;
    for (const p of fresh) {
      const go = () => {
        if (gen !== this.generation || !this.ws || !this.isConnected) {
          // Link lost mid-replay: put it back; it goes out after the reconnect if still fresh.
          this.pending.push(p);
          return;
        }
        this.ws.send(p.msg);
        if (p.key && p.cmd === 'Press' && p.holdMs === undefined) this.pressDelay.set(p.key, Math.max(0, this.now() - p.at));
        if (p.key && p.cmd === 'Release') this.pressDelay.delete(p.key);
        if (p.holdMs !== undefined && p.key) {
          const key = p.key;
          setTimeout(() => this.sendKey(key, 'Release'), p.holdMs);
        }
        this.replayLeft--;
        if (this.replayLeft === 0) this.flushPending(); // keys pressed during the replay
      };
      const delay = p.at - base;
      if (delay <= 0) go();
      else setTimeout(go, delay);
    }
  }

  private open(): void {
    const gen = ++this.generation;
    const url = channelUrl(this.opts.config, REMOTE_CHANNEL, CLIENT_NAME, this.token);
    this.log(`→ connect ${url.replace(/token=[^&]+/, 'token=***')}`);
    this.openedAt = this.now();
    this.setStatus({ status: 'connecting' });

    let ws: SocketLike;
    try {
      ws = this.opts.createSocket(url);
    } catch (e) {
      this.fail(`Could not open socket: ${String(e)}`);
      return;
    }
    this.ws = ws;
    let gotEvent = false;

    this.after(OPEN_TIMEOUT_MS, () => {
      if (gen === this.generation && this.status === 'connecting') {
        this.fail('TV did not answer. Check the IP, Wi-Fi and that the TV is on / in Art Mode.');
      }
    });

    ws.onopen = () => {
      if (gen !== this.generation) return;
      this.log(`socket open (${this.now() - this.openedAt} ms), waiting for TV`);
      this.setStatus({ status: 'awaitingAllow', message: 'If the TV shows a prompt, choose Allow.' });
      this.after(REGISTER_AFTER_MS, () => {
        if (gen === this.generation && !gotEvent && this.ws) {
          this.log('TV silent → sending register frame (Tizen 9 workaround)');
          this.ws.send(registerMessage());
        }
      });
      this.after(ALLOW_TIMEOUT_MS, () => {
        if (gen === this.generation && this.status === 'awaitingAllow') {
          this.fail('No response from TV. Was the Allow prompt accepted?');
        }
      });
    };

    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      const raw = typeof ev.data === 'string' ? ev.data : '';
      const frame = parseFrame(raw);
      if (!frame) return;
      gotEvent = true;
      if (NOISE_EVENTS.has(frame.event)) return;
      this.log(`← ${frame.event}`);
      this.opts.onFrame?.(frame.event, frame.data);

      if (frame.event === 'ms.channel.connect') {
        const token = tokenFromConnect(frame);
        if (token && token !== this.token) {
          this.token = token;
          this.opts.onToken(token);
          this.log('paired: token saved');
        }
        this.attempt = 0;
        this.clearTimers();
        this.log(`connected in ${this.now() - this.openedAt} ms`);
        this.setStatus({ status: 'connected' });
        this.flushPending();
      } else if (UNAUTHORIZED_EVENTS.has(frame.event)) {
        this.token = null;
        this.opts.onToken(null);
        this.wanted = false; // don't hammer the TV with prompts
        this.pending = []; // never fire old presses after a later re-pair
        this.teardown();
        this.setStatus({
          status: 'unauthorized',
          message:
            'TV refused the connection. Press Allow on the TV, or remove "FrameRemote" from Device Connection Manager and retry.',
        });
      }
    };

    ws.onerror = (ev) => {
      if (gen !== this.generation) return;
      this.log(`socket error${ev.message ? `: ${ev.message}` : ''}`);
      if (ev.fatal) {
        // e.g. the TV's certificate no longer matches the pinned one: retrying can't help.
        this.wanted = false;
        this.pending = [];
        this.teardown();
        this.setStatus({ status: 'error', message: ev.message ?? 'Connection rejected.' });
        return;
      }
      // Not every WebSocket implementation follows an error with a close event, so treat the
      // error itself as the failure (teardown detaches handlers, so a later close is ignored).
      if (this.status !== 'unauthorized') {
        this.fail(
          this.status === 'connected'
            ? 'Connection lost. Reconnecting…'
            : 'Could not connect. Check the IP, Wi-Fi, and that the TV is on or in Art Mode.',
        );
      }
    };

    ws.onclose = (ev) => {
      if (gen !== this.generation) return;
      this.log(`socket closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`);
      this.ws = null;
      this.clearTimers();
      if (this.status === 'unauthorized') return;
      this.fail(
        this.status === 'connected'
          ? 'Connection lost. Reconnecting…'
          : 'Could not connect. Check the IP, Wi-Fi, and that the TV is on or in Art Mode.',
      );
    };
  }

  /** Mark an error and schedule a retry if we still want to be connected. */
  private fail(message: string): void {
    this.teardown();
    this.setStatus({ status: 'error', message });
    if (!this.wanted) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.log(`retry in ${delay < 1000 ? `${delay} ms` : `${delay / 1000}s`}`);
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.open();
    }, delay);
  }

  private teardown(): void {
    this.generation++;
    this.verifying = false;
    this.replayLeft = 0;
    this.pressDelay.clear();
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setStatus(s: ConnSnapshot): void {
    this.snapshot = s;
    this.opts.onStatus(s);
  }

  private log(line: string): void {
    this.opts.onLog?.(line);
  }
}
