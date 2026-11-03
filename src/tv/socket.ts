// The minimal WebSocket shape the TV code relies on. Implemented by:
//  - TvSocket (modules/tv-socket): native iOS socket that accepts the TV's self-signed cert
//  - the `ws` package in tests (with rejectUnauthorized: false)

export interface SocketErrorEvent {
  message?: string;
  /** True when retrying can't help (e.g. the TV's certificate changed). */
  fatal?: boolean;
}

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: SocketErrorEvent) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
  /** Optional liveness check (a WebSocket ping): resolves false if no pong within the timeout. */
  checkAlive?: (timeoutMs: number) => Promise<boolean>;
}

export type SocketFactory = (url: string) => SocketLike;
