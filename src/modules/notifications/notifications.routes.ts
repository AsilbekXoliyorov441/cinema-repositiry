import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendSuccess } from '../../common/http/response.js';
import { paginationQuery } from '../../common/utils/pagination.js';
import { idParam } from '../../common/utils/schemas.js';
import { notificationsService } from './notifications.service.js';

const api = new ApiRouter('Me · Notifications');

const notificationSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.unknown(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});

api
  .route({
    method: 'get',
    path: '/me/notifications',
    summary: 'My notifications',
    auth: 'user',
    query: paginationQuery.extend({ unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }),
    response: notificationSchema,
    paginated: true,
    handler: async ({ res, query, actor }) => {
      const { items, meta } = await notificationsService.list(actor().userId, query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'get',
    path: '/me/notifications/unread-count',
    summary: 'Unread notification count',
    auth: 'user',
    response: z.object({ count: z.number().int() }),
    handler: async ({ res, actor }) => sendSuccess(res, { count: await notificationsService.unreadCount(actor().userId) }),
  })
  .route({
    method: 'post',
    path: '/me/notifications/:id/read',
    summary: 'Mark a notification as read',
    auth: 'user',
    params: idParam,
    response: null,
    errors: [404],
    handler: async ({ res, params, actor }) => {
      await notificationsService.markRead(actor().userId, params.id);
      sendSuccess(res, null, { message: 'Marked as read' });
    },
  })
  .route({
    method: 'post',
    path: '/me/notifications/read-all',
    summary: 'Mark all notifications as read',
    auth: 'user',
    response: z.object({ updated: z.number().int() }),
    handler: async ({ res, actor }) => sendSuccess(res, await notificationsService.markAllRead(actor().userId)),
  })
  .route({
    method: 'post',
    path: '/admin/notifications',
    tags: ['Admin · Notifications'],
    summary: 'Send a system notification to users',
    permissions: [PERMISSIONS.NOTIFICATIONS_SEND],
    body: z.object({ userIds: z.array(z.uuid()).min(1).max(1000), title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(2000) }),
    response: z.object({ sent: z.number().int() }),
    handler: async ({ res, body }) => sendSuccess(res, await notificationsService.sendSystem(body.userIds, body.title, body.body)),
  });

export const notificationsRouter = api.router;
