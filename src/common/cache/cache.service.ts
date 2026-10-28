import { redis } from '../../config/redis.js';
import { logger } from '../../config/logger.js';
import { sha256Hex } from '../utils/crypto.js';

/**
 * Namespaced, versioned JSON cache on Redis.
 *
 * Keys look like `cache:<namespace>:v<version>:<hash>`. Invalidating a namespace increments its
 * version, which atomically orphans every key of the previous version (they expire by TTL).
 * Every operation is best-effort: if Redis is down the cache is bypassed, never trusted.
 */
export const CacheNamespace = {
  CATALOG: 'catalog',
  GENRES: 'genres',
  PLANS: 'plans',
  SETTINGS: 'settings',
} as const;
export type CacheNamespace = (typeof CacheNamespace)[keyof typeof CacheNamespace];

async function namespaceVersion(ns: CacheNamespace): Promise<string> {
  return (await redis.get(`cache:ver:${ns}`)) ?? '0';
}

export const cache = {
  async wrap<T>(ns: CacheNamespace, keyParts: unknown, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    let key: string | undefined;
    try {
      key = `cache:${ns}:v${await namespaceVersion(ns)}:${sha256Hex(JSON.stringify(keyParts)).slice(0, 32)}`;
      const hit = await redis.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (err) {
      logger.debug({ err: (err as Error).message, ns }, 'cache read skipped');
    }
    const value = await loader();
    if (key) {
      redis.set(key, JSON.stringify(value), 'EX', ttlSeconds).catch(() => undefined);
    }
    return value;
  },

  async invalidate(...namespaces: CacheNamespace[]): Promise<void> {
    await Promise.all(
      namespaces.map((ns) =>
        redis.incr(`cache:ver:${ns}`).catch((err: Error) => logger.warn({ err: err.message, ns }, 'cache invalidation failed')),
      ),
    );
  },
};
