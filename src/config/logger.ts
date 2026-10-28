import { pino } from 'pino';
import { env, isProduction } from './env.js';

/**
 * Paths that must never reach log storage. pino replaces them with "[REDACTED]".
 */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["stripe-signature"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.secret',
  '*.mfaSecret',
  '*.code',
  'password',
  'token',
  'refreshToken',
  'accessToken',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'cinewave-api' },
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProduction || env.NODE_ENV === 'test'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }),
});

export type Logger = typeof logger;
