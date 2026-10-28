import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { hmacSha256Hex, randomToken } from '../../common/utils/crypto.js';
import { durationToMs } from '../../common/utils/duration.js';

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessTokenClaims {
  sub: string;
  sid: string;
}

export const accessTokenTtlMs = durationToMs(env.JWT_ACCESS_EXPIRES_IN);
export const refreshTokenTtlMs = durationToMs(env.JWT_REFRESH_EXPIRES_IN);

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ sid: claims.sid, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + accessTokenTtlMs) / 1000))
    .sign(accessKey);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessKey, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw AppError.unauthenticated('Invalid access token');
    }
    return { sub: payload.sub, sid: payload.sid };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof joseErrors.JWTExpired) {
      throw AppError.unauthenticated('Access token expired', ErrorCode.TOKEN_EXPIRED);
    }
    throw AppError.unauthenticated('Invalid access token');
  }
}

/** Short-lived token proving password verification while waiting for the MFA code. */
export async function signMfaChallengeToken(userId: string): Promise<string> {
  return new SignJWT({ typ: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(accessKey);
}

export async function verifyMfaChallengeToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, accessKey, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (payload.typ !== 'mfa' || typeof payload.sub !== 'string') throw new Error('wrong type');
    return payload.sub;
  } catch {
    throw AppError.unauthenticated('MFA challenge expired or invalid');
  }
}

/**
 * Opaque refresh / one-time tokens. Only an HMAC (keyed with JWT_REFRESH_SECRET) is stored,
 * so a database leak does not expose usable tokens.
 */
export function generateOpaqueToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return hmacSha256Hex(env.JWT_REFRESH_SECRET, token);
}
