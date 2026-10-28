import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendSuccess } from '../../common/http/response.js';
import { settingKeys, settingsService } from './settings.service.js';

const api = new ApiRouter('Admin · Settings');

api
  .route({
    method: 'get',
    path: '/admin/settings',
    summary: 'List site settings',
    permissions: [PERMISSIONS.SETTINGS_MANAGE],
    response: z.array(z.object({ key: z.string(), value: z.unknown(), default: z.unknown(), description: z.string(), permission: z.string() })),
    handler: async ({ res }) => sendSuccess(res, await settingsService.list()),
  })
  .route({
    method: 'put',
    path: '/admin/settings/:key',
    summary: 'Change a site setting',
    description: 'Payment-related keys additionally require `payment_settings:manage` (super admin).',
    permissions: [PERMISSIONS.SETTINGS_MANAGE],
    params: z.object({ key: z.enum(settingKeys) }),
    body: z.object({ value: z.unknown() }),
    response: z.object({ key: z.string(), value: z.unknown() }),
    handler: async ({ res, params, body, actor, client }) => {
      const a = actor();
      sendSuccess(res, await settingsService.set(params.key, body.value, { userId: a.userId, permissions: a.permissions, client }));
    },
  });

export const settingsRouter = api.router;
