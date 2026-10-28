import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '../errors/app-error.js';
import { verifyAccessToken } from '../../modules/auth/token.service.js';
import { loadAuthContext } from '../../modules/auth/auth-context.service.js';
import type { Permission } from '../constants/permissions.js';
import { STAFF_MIN_LEVEL } from '../constants/permissions.js';
import { env } from '../../config/env.js';

function extractBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw AppError.unauthenticated('Malformed Authorization header');
  return token;
}

/** mode "required": 401 without a valid token. mode "optional": attaches auth when a valid token is present. */
export function authenticate(mode: 'required' | 'optional') {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearer(req);
    if (!token) {
      if (mode === 'required') throw AppError.unauthenticated();
      return next();
    }
    // An invalid/expired token is rejected even on optional routes, so clients refresh instead of silently
    // receiving a degraded guest response.
    const claims = await verifyAccessToken(token);
    req.auth = await loadAuthContext(claims.sub, claims.sid);
    next();
  };
}

export function requirePermissions(permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) throw AppError.unauthenticated();
    const missing = permissions.filter((p) => !auth.permissions.has(p));
    if (missing.length) throw AppError.forbidden();
    if (env.REQUIRE_ADMIN_MFA && auth.roleLevel >= STAFF_MIN_LEVEL && !auth.mfaVerified) {
      throw AppError.forbidden('Multi-factor authentication is required for staff accounts', ErrorCode.MFA_REQUIRED);
    }
    next();
  };
}

export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) throw AppError.unauthenticated();
  if (!req.auth.emailVerified) {
    throw AppError.forbidden('Please verify your email address first', ErrorCode.EMAIL_NOT_VERIFIED);
  }
  next();
}
