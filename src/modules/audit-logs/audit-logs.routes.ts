import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendSuccess } from '../../common/http/response.js';
import { buildMeta, paginationQuery, toSkipTake } from '../../common/utils/pagination.js';

const api = new ApiRouter('Admin · Audit');

api.route({
  method: 'get',
  path: '/admin/audit-logs',
  summary: 'Search audit logs',
  description: 'HIGH severity entries (role/permission changes, refunds, settings) are visible only with `audit:read_sensitive`.',
  permissions: [PERMISSIONS.AUDIT_READ],
  query: paginationQuery.extend({
    actorId: z.uuid().optional(),
    action: z.string().max(100).optional(),
    entityType: z.string().max(50).optional(),
    entityId: z.string().max(100).optional(),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  }),
  response: z.object({
    id: z.uuid(),
    actor: z.object({ id: z.uuid(), email: z.string(), displayName: z.string() }).nullable(),
    action: z.string(),
    entityType: z.string().nullable(),
    entityId: z.string().nullable(),
    severity: z.string(),
    metadata: z.unknown(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.string(),
  }),
  paginated: true,
  handler: async ({ res, query, actor }) => {
    const canSeeSensitive = actor().permissions.has(PERMISSIONS.AUDIT_READ_SENSITIVE);
    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from || query.to ? { createdAt: { gte: query.from ? new Date(query.from) : undefined, lt: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined } } : {}),
      severity: canSeeSensitive ? query.severity : query.severity === 'HIGH' ? { in: [] } : (query.severity ?? { in: ['LOW', 'MEDIUM'] }),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, include: { actor: { select: { id: true, email: true, displayName: true } } }, ...toSkipTake(query) }),
      prisma.auditLog.count({ where }),
    ]);
    sendSuccess(
      res,
      rows.map((r) => ({ ...r, actorId: undefined, createdAt: r.createdAt.toISOString() })),
      { meta: buildMeta(query, total) },
    );
  },
});

export const auditLogsRouter = api.router;
