import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { addMs } from '../../common/utils/duration.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import {
  accessTokenTtlMs,
  generateOpaqueToken,
  hashOpaqueToken,
  refreshTokenTtlMs,
  signAccessToken,
} from './token.service.js';

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresIn: number; // seconds
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}

interface ClientInfo {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export async function createSession(userId: string, client: ClientInfo, mfaVerified: boolean): Promise<IssuedTokens> {
  const now = new Date();
  const expiresAt = addMs(now, refreshTokenTtlMs);
  const { token, hash } = generateOpaqueToken();

  const session = await prisma.$transaction(async (tx) => {
    const s = await tx.session.create({
      data: {
        userId,
        userAgent: client.userAgent ?? null,
        ipAddress: client.ip ?? null,
        mfaVerified,
        expiresAt,
      },
    });
    await tx.refreshToken.create({ data: { sessionId: s.id, tokenHash: hash, expiresAt } });
    await tx.user.update({ where: { id: userId }, data: { lastLoginAt: now } });
    return s;
  });

  return {
    accessToken: await signAccessToken({ sub: userId, sid: session.id }),
    accessTokenExpiresIn: Math.floor(accessTokenTtlMs / 1000),
    refreshToken: token,
    refreshTokenExpiresAt: expiresAt,
    sessionId: session.id,
  };
}

/**
 * Refresh-token rotation with reuse detection.
 * Every refresh token is single-use. Presenting an already-used token means it was copied —
 * the entire session (token family) is revoked and the user must log in again.
 */
export async function rotateRefreshToken(rawToken: string, client: ClientInfo): Promise<IssuedTokens> {
  const tokenHash = hashOpaqueToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { session: { include: { user: { select: { id: true, status: true, deletedAt: true } } } } },
  });
  if (!existing) throw AppError.unauthenticated('Invalid refresh token');

  const { session } = existing;
  const now = new Date();

  if (existing.usedAt) {
    await revokeSession(session.id, 'refresh_token_reuse');
    logger.warn({ sessionId: session.id, userId: session.userId }, 'Refresh token reuse detected — session revoked');
    await writeAudit({
      actorId: session.userId,
      action: 'auth.refresh_token_reuse',
      entityType: 'session',
      entityId: session.id,
      severity: 'HIGH',
      client,
    });
    throw AppError.unauthenticated('Refresh token was already used; session revoked');
  }
  if (existing.expiresAt < now || session.revokedAt || session.expiresAt < now) {
    throw AppError.unauthenticated('Refresh token expired');
  }
  if (session.user.deletedAt || session.user.status !== 'ACTIVE') {
    await revokeSession(session.id, 'account_disabled');
    throw AppError.forbidden('Account is disabled', ErrorCode.ACCOUNT_DISABLED);
  }

  const expiresAt = addMs(now, refreshTokenTtlMs);
  const { token, hash } = generateOpaqueToken();

  await prisma.$transaction(async (tx) => {
    // Conditional update makes concurrent use of the same token detectable: only one request wins.
    const marked = await tx.refreshToken.updateMany({
      where: { id: existing.id, usedAt: null },
      data: { usedAt: now },
    });
    if (marked.count !== 1) throw AppError.unauthenticated('Refresh token was already used');
    await tx.refreshToken.create({ data: { sessionId: session.id, tokenHash: hash, expiresAt } });
    await tx.session.update({
      where: { id: session.id },
      data: { lastUsedAt: now, expiresAt, ipAddress: client.ip ?? session.ipAddress, userAgent: client.userAgent ?? session.userAgent },
    });
  });

  return {
    accessToken: await signAccessToken({ sub: session.userId, sid: session.id }),
    accessTokenExpiresIn: Math.floor(accessTokenTtlMs / 1000),
    refreshToken: token,
    refreshTokenExpiresAt: expiresAt,
    sessionId: session.id,
  };
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
}

export async function revokeSessionByRefreshToken(rawToken: string): Promise<void> {
  const token = await prisma.refreshToken.findUnique({ where: { tokenHash: hashOpaqueToken(rawToken) }, select: { sessionId: true } });
  if (token) await revokeSession(token.sessionId, 'logout');
}

export async function revokeAllUserSessions(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
  return result.count;
}

export async function listActiveSessions(userId: string, currentSessionId: string) {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
    select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastUsedAt: true, expiresAt: true, mfaVerified: true },
  });
  return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
}

export async function revokeOwnSession(userId: string, sessionId: string): Promise<void> {
  const result = await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: 'user_revoked' },
  });
  // Same response for "not yours" and "does not exist" to avoid leaking session ids (IDOR).
  if (result.count === 0) throw AppError.notFound('Session');
}
