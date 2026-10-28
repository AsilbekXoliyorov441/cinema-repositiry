import type { Readable } from 'node:stream';

export type StorageDriverName = 'LOCAL' | 'S3';

/**
 * Object storage abstraction. Business code only talks to this interface, so switching from local
 * disk to S3-compatible storage means adding an adapter — not touching controllers or services.
 *
 * Keys are server-generated, `/`-separated, and start with `public/` or `private/`.
 */
export interface StorageService {
  readonly driver: StorageDriverName;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Absolute URL for public keys; undefined for private keys (served through the API). */
  publicUrl(key: string): string | undefined;
  /** Iterates all stored objects (used by the orphan-file scanner). */
  listObjects(): AsyncIterable<{ key: string; lastModified: Date }>;
}
