import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';

export const REFRESH_COOKIE = 'cw_refresh';

function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    domain: env.COOKIE_DOMAIN,
    // Only sent to auth endpoints — never to the rest of the API.
    path: `${env.API_PREFIX}/auth`,
  };
}

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...baseOptions(), expires: expiresAt });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions());
}

export function readRefreshToken(req: Request, bodyToken?: string): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[REFRESH_COOKIE] ?? bodyToken;
}
