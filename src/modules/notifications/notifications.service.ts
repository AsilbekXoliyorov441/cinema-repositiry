import type { NotificationType, Prisma } from '@prisma/client';
import { prisma, type DbOrTx } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/app-error.js';
import { buildMeta, toSkipTake, type PaginationInput } from '../../common/utils/pagination.js';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
}

export const notificationsService = {
  /** Creates an in-app notification. Outside a transaction failures are logged, never thrown. */
  async notify(input: NotifyInput, db: DbOrTx = prisma): Promise<void> {
    const data = { userId: input.userId, type: input.type, title: input.title, body: input.body, data: input.data };
    if (db !== prisma) {
      await db.notification.create({ data });
      return;
    }
    await prisma.notification.create({ data }).catch((err: Error) => logger.error({ err: err.message, type: input.type }, 'Failed to create notification'));
  },

  async list(userId: string, query: PaginationInput & { unread?: boolean | undefined }) {
    const where: Prisma.NotificationWhereInput = { userId, ...(query.unread ? { readAt: null } : {}) };
    const [rows, total] = await prisma.$transaction([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
      prisma.notification.count({ where }),
    ]);
    return {
      items: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })),
      meta: buildMeta(query, total),
    };
  },

  unreadCount(userId: string) {
    return prisma.notification.count({ where: { userId, readAt: null } });
  },

  async markRead(userId: string, id: string) {
    const r = await prisma.notification.updateMany({ where: { id, userId }, data: { readAt: new Date() } });
    if (r.count === 0) throw AppError.notFound('Notification');
  },

  async markAllRead(userId: string) {
    const r = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: r.count };
  },

  /** Admin broadcast to specific users (bounded) — e.g. service announcements. */
  async sendSystem(userIds: string[], title: string, body: string) {
    const existing = await prisma.user.findMany({ where: { id: { in: userIds }, deletedAt: null }, select: { id: true } });
    await prisma.notification.createMany({ data: existing.map((u) => ({ userId: u.id, type: 'SYSTEM' as const, title, body })) });
    return { sent: existing.length };
  },
};
