import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

const baseOptions: RedisOptions = {
  lazyConnect: false,
  enableReadyCheck: true,
  connectTimeout: 5_000,
};

/** General-purpose client: cache, rate limiting, locks. Commands fail fast when Redis is down. */
export const redis = new Redis(env.REDIS_URL, {
  ...baseOptions,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
});

redis.on('error', (err) => logger.warn({ err: err.message }, 'Redis error'));

/**
 * BullMQ requires `maxRetriesPerRequest: null` on its connections.
 * Each Queue/Worker gets its own connection created by this factory.
 */
export function createBullConnection(): Redis {
  const conn = new Redis(env.REDIS_URL, { ...baseOptions, maxRetriesPerRequest: null });
  conn.on('error', (err) => logger.warn({ err: err.message }, 'BullMQ Redis error'));
  return conn;
}

let pendingReady: Promise<void> | undefined;

/**
 * Resolves once the shared client is connected (rejects after `timeoutMs`). Concurrent callers
 * (every rate limiter at import time) share one listener instead of piling up 'ready' handlers.
 */
export function redisReady(timeoutMs = 5_000): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  pendingReady ??= new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      reject(new Error('Redis not ready'));
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    redis.once('ready', onReady);
  }).finally(() => {
    pendingReady = undefined;
  });
  return pendingReady;
}

export async function checkRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
