import type { NextFunction, Request, Response } from 'express';
import { allowedOrigins } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

/**
 * CSRF protection for endpoints authenticated by the refresh-token cookie (refresh, logout, OAuth).
 * Access tokens travel in the Authorization header and are not CSRF-prone.
 *
 * Two independent checks:
 *  1. A custom header (`X-Requested-With`) must be present. Browsers cannot send custom headers
 *     cross-origin without a CORS preflight, which our allowlist rejects.
 *  2. If the browser sends Origin (or Referer), it must be an allowlisted origin.
 */
export function cookieCsrfGuard(req: Request, _res: Response, next: NextFunction): void {
  if (!req.get('x-requested-with')) {
    throw AppError.forbidden('Missing X-Requested-With header');
  }
  const origin = req.get('origin') ?? refererOrigin(req.get('referer'));
  if (origin && !allowedOrigins.includes(origin)) {
    throw AppError.forbidden('Origin not allowed');
  }
  next();
}

function refererOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
