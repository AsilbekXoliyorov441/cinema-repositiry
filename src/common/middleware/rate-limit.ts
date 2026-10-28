import type { Request, RequestHandler } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { env } from '../../config/env.js';
import { redis, redisReady } from '../../config/redis.js';
import { AppError, ErrorCode } from '../errors/app-error.js';

interface LimiterOptions {
  name: string;
  windowMs: number;
  limit: number;
  /** Key by authenticated user when available (falls back to IP). */
  perUser?: boolean;
  /** Extra key component, e.g. the email in a login body (normalized). */
  keyExtra?: (req: Request) => string | undefined;
}

const passthrough: RequestHandler = (_req, _res, next) => next();

/**
 * Redis-backed rate limiter. When Redis is unavailable the limiter lets requests through
 * (`passOnStoreError`) rather than taking the whole API down; auth endpoints remain protected by
 * Argon2's cost and the account-level checks in the auth service.
 */
export function createRateLimiter(opts: LimiterOptions): RequestHandler {
  if (!env.RATE_LIMIT_ENABLED) return passthrough;

  const options: Partial<Options> = {
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    passOnStoreError: true,
    store: new RedisStore({
      prefix: `rl:${opts.name}:`,
      // The store loads its Lua scripts at construction time (module import), so wait for the connection.
      sendCommand: async (command: string, ...args: string[]) => {
        await redisReady();
        return redis.call(command, ...args) as Promise<RedisReply>;
      },
    }),
    keyGenerator: (req) => {
      const base = opts.perUser && req.auth ? `u:${req.auth.userId}` : `ip:${req.ip ?? 'unknown'}`;
      const extra = opts.keyExtra?.(req);
      return extra ? `${base}:${extra}` : base;
    },
    handler: (_req, _res, next) => {
      next(new AppError(429, ErrorCode.RATE_LIMITED, 'Too many requests, please try again later'));
    },
  };
  return rateLimit(options);
}

const MIN = 60_000;

export const rateLimiters = {
  global: createRateLimiter({ name: 'global', windowMs: MIN, limit: env.RATE_LIMIT_GLOBAL_PER_MINUTE }),
  auth: createRateLimiter({ name: 'auth', windowMs: 15 * MIN, limit: env.RATE_LIMIT_AUTH_PER_15MIN }),
  login: createRateLimiter({
    name: 'login',
    windowMs: 15 * MIN,
    limit: 10,
    keyExtra: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 320) : undefined;
    },
  }),
  emailSend: createRateLimiter({ name: 'email-send', windowMs: 60 * MIN, limit: 5 }),
  refresh: createRateLimiter({ name: 'refresh', windowMs: MIN, limit: 30 }),
  progress: createRateLimiter({ name: 'progress', windowMs: MIN, limit: 30, perUser: true }),
  writeContent: createRateLimiter({ name: 'ugc', windowMs: 10 * MIN, limit: 20, perUser: true }),
  checkout: createRateLimiter({ name: 'checkout', windowMs: 10 * MIN, limit: 10, perUser: true }),
  upload: createRateLimiter({ name: 'upload', windowMs: MIN, limit: 30, perUser: true }),
};
