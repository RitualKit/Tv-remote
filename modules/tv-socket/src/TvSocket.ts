// WebSocket-shaped wrapper around the native TvSocket module. Kept free of `expo` imports so
// it can be unit-tested in Node with a fake native module.

export interface TvSocketEvents {
  onOpen: (e: { id: string; certSha256?: string | null }) => void;
  onMessage: (e: { id: string; data: string }) => void;
  onClose: (e: { id: string; code: number; reason?: string }) => void;
  onError: (e: { id: string; message?: string; fatal?: boolean }) => void;
}

export interface Subscription {
  remove(): void;
}

/** The subset of the native module (an Expo NativeModule / EventEmitter) that we use. */
export interface TvSocketNative {
  open(id: string, url: string, pinnedSha256: string | null): void;
  send(id: string, text: string): void;
  close(id: string): void;
  /** WebSocket ping; resolves true if the pong arrives within `timeoutMs`. */
  ping(id: string, timeoutMs: number): Promise<boolean>;
  addListener<K extends keyof TvSocketEvents>(event: K, listener: TvSocketEvents[K]): Subscription;
}

export interface TvSocketOptions {
  /** SHA-256 (hex) of the TV's certificate saved on first connect; null = trust on first use. */
  pinnedSha256?: string | null;
  /** Called once the TLS handshake succeeds, with the certificate fingerprint actually seen. */
  onCertificate?: (sha256: string) => void;
}

let nextId = 1;

export class TvSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message?: string; fatal?: boolean }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;

  /** 0 connecting, 1 open, 3 closed (same numbers as WebSocket). */
  readyState = 0;
  certSha256: string | null = null;

  private readonly id = `tv${nextId++}`;
  private subs: Subscription[] = [];

  constructor(
    url: string,
    private readonly native: TvSocketNative,
    private readonly options: TvSocketOptions = {},
  ) {
    const mine = (e: { id: string }) => e.id === this.id;
    this.subs = [
      native.addListener('onOpen', (e) => {
        if (!mine(e) || this.readyState !== 0) return;
        this.readyState = 1;
        if (e.certSha256) {
          this.certSha256 = e.certSha256;
          this.options.onCertificate?.(e.certSha256);
        }
        this.onopen?.();
      }),
      native.addListener('onMessage', (e) => {
        if (mine(e) && this.readyState === 1) this.onmessage?.({ data: e.data });
      }),
      native.addListener('onError', (e) => {
        if (mine(e) && this.readyState !== 3) this.onerror?.({ message: e.message, fatal: e.fatal });
      }),
      native.addListener('onClose', (e) => {
        if (!mine(e) || this.readyState === 3) return;
        this.readyState = 3;
        this.unsubscribe();
        this.onclose?.({ code: e.code, reason: e.reason });
      }),
    ];
    native.open(this.id, url, options.pinnedSha256 ?? null);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('TvSocket is not open');
    this.native.send(this.id, data);
  }

  /** Liveness check used when the app returns to the foreground. */
  checkAlive(timeoutMs: number): Promise<boolean> {
    if (this.readyState !== 1) return Promise.resolve(false);
    return this.native.ping(this.id, timeoutMs).then(
      (alive) => alive === true,
      () => false,
    );
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.unsubscribe();
    this.native.close(this.id);
  }

  private unsubscribe(): void {
    this.subs.forEach((s) => s.remove());
    this.subs = [];
  }
}
