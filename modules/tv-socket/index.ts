import { requireOptionalNativeModule } from 'expo';
import { TvSocket, TvSocketNative, TvSocketOptions } from './src/TvSocket';

export { TvSocket } from './src/TvSocket';
export type { TvSocketOptions } from './src/TvSocket';

// Optional so a JS bundle running somewhere without the native code (e.g. Expo Go) fails with a
// clear message instead of crashing at import time.
const native = requireOptionalNativeModule<TvSocketNative>('TvSocket');

export const isTvSocketAvailable = native != null;

export function createTvSocket(url: string, options?: TvSocketOptions): TvSocket {
  if (!native) {
    throw new Error('TvSocket native module is missing. Use the sideloaded Frame Remote build (not Expo Go).');
  }
  return new TvSocket(url, native, options);
}
