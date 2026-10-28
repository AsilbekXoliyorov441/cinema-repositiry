import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthContext } from '../../common/types/auth.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { rbacPolicy } from './rbac.policy.js';
import type { z } from 'zod';
import type { createRoleBody, updateRoleBody } from './roles.schemas.js';

type Client = { ip?: string | undefined; userAgent?: string | undefined };

const roleInclude = {
  permissions: { select: { permission: { select: { key: true } } } },
  _count: { select: { users: true } },
} as const;

function toRoleView(r: {
  id: string;
  name: string;
  description: string | null;
  level: number;
  isSystem: boolean;
  permissions: { permission: { key: string } }[];
  _count: { users: number };
}) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    level: r.level,
    isSystem: r.isSystem,
    permissions: r.permissions.map((p) => p.permission.key).sort(),
    userCount: r._count.users,
  };
}

async function permissionIds(keys: string[]): Promise<string[]> {
  const rows = await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
  if (rows.length !== new Set(keys).size) throw AppError.validation([{ path: 'permissions', message: 'Unknown permission' }]);
  return rows.map((r) => r.id);
}

async function getRoleOr404(id: string) {
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw AppError.notFound('Role');
  return role;
}

export const rolesService = {
  async list() {
    const roles = await prisma.role.findMany({ include: roleInclude, orderBy: { level: 'desc' } });
    return roles.map(toRoleView);
  },

  listPermissions() {
    return prisma.permission.findMany({ select: { key: true, description: true }, orderBy: { key: 'asc' } });
  },

  async create(actor: AuthContext, input: z.infer<typeof createRoleBody>, client: Client) {
    rbacPolicy.assertCanManageRoleLevel(actor, input.level);
    rbacPolicy.assertCanGrantPermissions(actor, input.permissions);
    const ids = await permissionIds(input.permissions);
    const role = await prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          name: input.name,
          description: input.description ?? null,
          level: input.level,
          permissions: { create: ids.map((permissionId) => ({ permissionId })) },
        },
        include: roleInclude,
      });
      await writeAudit(
        { actorId: actor.userId, action: 'role.create', entityType: 'role', entityId: created.id, severity: 'HIGH', metadata: input, client },
        tx,
      );
      return created;
    });
    return toRoleView(role);
  },

  async update(actor: AuthContext, id: string, input: z.infer<typeof updateRoleBody>, client: Client) {
    const role = await getRoleOr404(id);
    rbacPolicy.assertCanManageRoleLevel(actor, role.level);
    if (input.level !== undefined) {
      if (role.isSystem) throw AppError.forbidden('System role levels cannot be changed');
      rbacPolicy.assertCanManageRoleLevel(actor, input.level);
    }
    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.role.update({
        where: { id },
        data: { description: input.description, level: input.level },
        include: roleInclude,
      });
      await writeAudit({ actorId: actor.userId, action: 'role.update', entityType: 'role', entityId: id, severity: 'HIGH', metadata: input, client }, tx);
      return r;
    });
    return toRoleView(updated);
  },

  async setPermissions(actor: AuthContext, id: string, keys: string[], client: Client) {
    const role = await getRoleOr404(id);
    rbacPolicy.assertCanManageRoleLevel(actor, role.level);
    rbacPolicy.assertCanGrantPermissions(actor, keys);
    const ids = await permissionIds(keys);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: id, permissionId })) });
      await writeAudit(
        { actorId: actor.userId, action: 'role.set_permissions', entityType: 'role', entityId: id, severity: 'HIGH', metadata: { permissions: keys }, client },
        tx,
      );
      return tx.role.findUniqueOrThrow({ where: { id }, include: roleInclude });
    });
    return toRoleView(updated);
  },

  async remove(actor: AuthContext, id: string, client: Client) {
    const role = await prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw AppError.notFound('Role');
    if (role.isSystem) throw AppError.forbidden('System roles cannot be deleted');
    rbacPolicy.assertCanManageRoleLevel(actor, role.level);
    if (role._count.users > 0) throw AppError.conflict('Role is still assigned to users');
    await prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id } });
      await writeAudit({ actorId: actor.userId, action: 'role.delete', entityType: 'role', entityId: id, severity: 'HIGH', metadata: { name: role.name }, client }, tx);
    });
  },
};
