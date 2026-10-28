import { containsInsensitive } from '../../common/utils/search.js';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { SYSTEM_ROLES } from '../../common/constants/permissions.js';
import type { AuthContext } from '../../common/types/auth.js';
import { buildMeta, toSkipTake } from '../../common/utils/pagination.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { verifyPassword } from '../auth/password.service.js';
import { revokeAllUserSessions } from '../auth/session.service.js';
import { mediaService } from '../media/media.service.js';
import { rbacPolicy } from '../roles/rbac.policy.js';
import { toUserProfile, userProfileSelect } from './users.mapper.js';
import type { z } from 'zod';
import type { adminListUsersQuery, banBody, updateMeBody } from './users.schemas.js';

type Client = { ip?: string | undefined; userAgent?: string | undefined };

const adminUserSelect = {
  ...userProfileSelect,
  statusReason: true,
  lastLoginAt: true,
  isProtected: true,
  subscriptions: {
    where: { status: { in: ['ACTIVE', 'PAST_DUE', 'SUSPENDED'] } },
    select: { id: true, status: true, currentPeriodEnd: true, plan: { select: { name: true } } },
    take: 1,
  },
} satisfies Prisma.UserSelect;

type AdminUserRow = Prisma.UserGetPayload<{ select: typeof adminUserSelect }>;

function toAdminUser(u: AdminUserRow) {
  const sub = u.subscriptions[0];
  return {
    ...toUserProfile(u),
    statusReason: u.statusReason,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    isProtected: u.isProtected,
    activeSubscription: sub
      ? { id: sub.id, planName: sub.plan.name, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null }
      : null,
  };
}

async function loadTarget(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isProtected: true, status: true, roles: { select: { role: { select: { level: true } } } } },
  });
  if (!user) throw AppError.notFound('User');
  const roleLevel = Math.max(0, ...user.roles.map((r) => r.role.level));
  return { ...user, roleLevel };
}

export const usersService = {
  async getMe(userId: string) {
    return toUserProfile(await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: userProfileSelect }));
  },

  async updateMe(userId: string, input: z.infer<typeof updateMeBody>) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        displayName: input.displayName,
        birthDate: input.birthDate === undefined ? undefined : input.birthDate === null ? null : new Date(input.birthDate),
      },
      select: userProfileSelect,
    });
    return toUserProfile(user);
  },

  async setAvatar(userId: string, file: Express.Multer.File) {
    const media = await mediaService.uploadImage(file, { kind: 'AVATAR', visibility: 'PUBLIC', uploadedById: userId });
    const previous = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarMediaId: true } });
    const user = await prisma.user.update({ where: { id: userId }, data: { avatarMediaId: media.id }, select: userProfileSelect });
    if (previous.avatarMediaId) await mediaService.deleteIfUnreferenced(previous.avatarMediaId);
    return toUserProfile(user);
  },

  async removeAvatar(userId: string) {
    const previous = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { avatarMediaId: true } });
    await prisma.user.update({ where: { id: userId }, data: { avatarMediaId: null } });
    if (previous.avatarMediaId) await mediaService.deleteIfUnreferenced(previous.avatarMediaId);
  },

  /**
   * Account deletion = anonymization. Personal data is removed, but payments, subscriptions and
   * audit logs stay intact (legal/financial record keeping) and reference an anonymized user.
   */
  async deleteMe(auth: AuthContext, password: string, client: Client) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.isProtected) throw AppError.forbidden('The bootstrap super admin account cannot be deleted');
    if (user.passwordHash && !(await verifyPassword(user.passwordHash, password))) {
      throw AppError.badRequest('Password is incorrect');
    }
    const open = await prisma.subscription.findFirst({
      where: { userId: user.id, status: { in: ['ACTIVE', 'PAST_DUE'] }, cancelAtPeriodEnd: false, provider: { not: 'MANUAL' } },
    });
    if (open) throw AppError.conflict('Cancel your active subscription before deleting the account');

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          email: `deleted+${user.id}@deleted.invalid`,
          displayName: 'Deleted user',
          passwordHash: null,
          birthDate: null,
          avatarMediaId: null,
          mfaEnabled: false,
          mfaSecretEnc: null,
          status: 'DELETED',
          deletedAt: new Date(),
        },
      });
      await tx.oAuthAccount.deleteMany({ where: { userId: user.id } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'account_deleted' } });
      await tx.review.updateMany({ where: { userId: user.id, deletedAt: null }, data: { deletedAt: new Date() } });
      await writeAudit({ actorId: user.id, action: 'user.self_delete', entityType: 'user', entityId: user.id, severity: 'MEDIUM', client }, tx);
    });
    if (user.avatarMediaId) await mediaService.deleteIfUnreferenced(user.avatarMediaId);
  },

  // ───── Admin ─────

  async adminList(query: z.infer<typeof adminListUsersQuery>) {
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : { deletedAt: null }),
      ...(query.q
        ? {
            OR: [
              { email: containsInsensitive(query.q) },
              { displayName: containsInsensitive(query.q) },
            ],
          }
        : {}),
      ...(query.role ? { roles: { some: { role: { name: query.role } } } } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: adminUserSelect,
        orderBy: { [query.sort.field]: query.sort.direction },
        ...toSkipTake(query),
      }),
      prisma.user.count({ where }),
    ]);
    return { items: rows.map(toAdminUser), meta: buildMeta(query, total) };
  },

  async adminGet(id: string) {
    const user = await prisma.user.findUnique({ where: { id }, select: adminUserSelect });
    if (!user) throw AppError.notFound('User');
    return toAdminUser(user);
  },

  async ban(actor: AuthContext, userId: string, input: z.infer<typeof banBody>, client: Client) {
    const target = await loadTarget(userId);
    rbacPolicy.assertCanManageUser(actor, target);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status: input.status, statusReason: input.reason } });
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'banned' } });
      await writeAudit(
        { actorId: actor.userId, action: 'user.ban', entityType: 'user', entityId: userId, severity: 'HIGH', metadata: input, client },
        tx,
      );
    });
    return this.adminGet(userId);
  },

  async unban(actor: AuthContext, userId: string, client: Client) {
    const target = await loadTarget(userId);
    rbacPolicy.assertCanManageUser(actor, target);
    if (target.status === 'DELETED') throw AppError.conflict('Deleted accounts cannot be restored');
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE', statusReason: null } });
      await writeAudit({ actorId: actor.userId, action: 'user.unban', entityType: 'user', entityId: userId, severity: 'MEDIUM', client }, tx);
    });
    return this.adminGet(userId);
  },

  async setRoles(actor: AuthContext, userId: string, roleNames: string[], client: Client) {
    const target = await loadTarget(userId);
    rbacPolicy.assertCanManageUser(actor, target);

    const names = new Set([...roleNames, SYSTEM_ROLES.USER]);
    const roles = await prisma.role.findMany({ where: { name: { in: [...names] } } });
    if (roles.length !== names.size) throw AppError.validation([{ path: 'roles', message: 'Unknown role' }]);
    for (const role of roles) rbacPolicy.assertCanManageRoleLevel(actor, role.level);

    await prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId, roleId: r.id, grantedById: actor.userId })) });
      await writeAudit(
        { actorId: actor.userId, action: 'user.set_roles', entityType: 'user', entityId: userId, severity: 'HIGH', metadata: { roles: [...names] }, client },
        tx,
      );
    });
    // Force re-login so the new privilege set is established on a fresh session.
    await revokeAllUserSessions(userId, 'roles_changed');
    return this.adminGet(userId);
  },
};
