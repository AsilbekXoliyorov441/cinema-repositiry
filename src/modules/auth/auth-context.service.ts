import { prisma } from '../../config/database.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import type { AuthContext } from '../../common/types/auth.js';
import type { Permission } from '../../common/constants/permissions.js';

/**
 * Resolves the principal for a verified access token. Runs on every authenticated request so that
 * bans, logouts and role changes take effect immediately (no stale permissions inside JWTs).
 */
export async function loadAuthContext(userId: string, sessionId: string): Promise<AuthContext> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      userId: true,
      revokedAt: true,
      expiresAt: true,
      mfaVerified: true,
      user: {
        select: {
          id: true,
          email: true,
          status: true,
          emailVerifiedAt: true,
          birthDate: true,
          deletedAt: true,
          roles: {
            select: {
              role: {
                select: {
                  name: true,
                  level: true,
                  permissions: { select: { permission: { select: { key: true } } } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!session || session.userId !== userId || session.revokedAt || session.expiresAt < new Date()) {
    throw AppError.unauthenticated('Session is no longer valid');
  }
  const user = session.user;
  if (user.deletedAt || user.status !== 'ACTIVE') {
    throw AppError.forbidden('Account is disabled', ErrorCode.ACCOUNT_DISABLED);
  }

  const permissions = new Set<Permission>();
  let roleLevel = 0;
  const roles: string[] = [];
  for (const { role } of user.roles) {
    roles.push(role.name);
    roleLevel = Math.max(roleLevel, role.level);
    for (const rp of role.permissions) permissions.add(rp.permission.key as Permission);
  }

  return {
    userId: user.id,
    sessionId,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    roles,
    roleLevel,
    permissions,
    mfaVerified: session.mfaVerified,
    birthDate: user.birthDate,
  };
}
