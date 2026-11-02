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
}

const OPEN_TIMEOUT_MS = 8_000; // socket must open within this
const ALLOW_TIMEOUT_MS = 30_000; // user has this long to press Allow on the TV
const REGISTER_AFTER_MS = 3_000; // silent socket → send the experimental register frame
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * One persistent connection to the TV's remote-control channel.
 * Reconnects with backoff until disconnect() is called or the TV refuses us.
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

  constructor(private opts: SamsungRemoteOptions) {
    this.token = opts.token;
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
    this.clearRetry();
    this.teardown();
    this.setStatus({ status: 'idle' });
  }

  /** Returns false (and kicks off a reconnect) if not connected; keys are never queued. */
  sendKey(key: string, cmd: RemoteCmd = 'Click'): boolean {
    return this.sendRaw(keyMessage(key, cmd));
  }

  /** Press, hold for `ms`, release. Used for long-press power (full off on The Frame). */
  holdKey(key: string, ms: number): boolean {
    if (!this.sendKey(key, 'Press')) return false;
    setTimeout(() => this.sendKey(key, 'Release'), ms);
    return true;
  }

  launchApp(appId: string): boolean {
    return this.sendRaw(launchAppMessage(appId));
  }

  /** Reply arrives via onFrame as event 'ed.installedApp.get'. Not supported on every model. */
  requestInstalledApps(): boolean {
    return this.sendRaw(installedAppsMessage());
  }

  // -------------------------------------------------------------------------

  private sendRaw(msg: string): boolean {
    if (this.ws && this.isConnected) {
      this.ws.send(msg);
      return true;
    }
    this.connect();
    return false;
  }

  private open(): void {
    const gen = ++this.generation;
    const url = channelUrl(this.opts.config, REMOTE_CHANNEL, CLIENT_NAME, this.token);
    this.log(`→ connect ${url.replace(/token=[^&]+/, 'token=***')}`);
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
      this.log('socket open, waiting for TV');
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
        this.setStatus({ status: 'connected' });
      } else if (UNAUTHORIZED_EVENTS.has(frame.event)) {
        this.token = null;
        this.opts.onToken(null);
        this.wanted = false; // don't hammer the TV with prompts
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
    this.log(`retry in ${delay / 1000}s`);
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.open();
    }, delay);
  }

  private teardown(): void {
    this.generation++;
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
