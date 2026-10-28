import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { idParam } from '../../common/utils/schemas.js';
import { plansService } from './plans.service.js';
import { createPlanBody, planSchema, updatePlanBody } from './plans.schemas.js';

const api = new ApiRouter('Billing · Plans');
const admin = 'Admin · Billing';

api
  .route({
    method: 'get',
    path: '/plans',
    summary: 'Active subscription plans',
    response: z.array(planSchema),
    handler: async ({ res }) => sendSuccess(res, await plansService.listActive()),
  })
  .route({
    method: 'get',
    path: '/admin/plans',
    tags: [admin],
    summary: 'All plans including inactive',
    permissions: [PERMISSIONS.PLANS_MANAGE],
    response: z.array(planSchema),
    handler: async ({ res }) => sendSuccess(res, await plansService.listAll()),
  })
  .route({
    method: 'post',
    path: '/admin/plans',
    tags: [admin],
    summary: 'Create plan',
    permissions: [PERMISSIONS.PLANS_MANAGE],
    body: createPlanBody,
    response: planSchema,
    responseStatus: 201,
    errors: [409],
    handler: async ({ res, body, actor, client }) => sendCreated(res, await plansService.create(body, { userId: actor().userId, client })),
  })
  .route({
    method: 'patch',
    path: '/admin/plans/:id',
    tags: [admin],
    summary: 'Update or deactivate plan',
    description: 'Set `isActive: false` to stop selling a plan. Existing subscribers keep their price.',
    permissions: [PERMISSIONS.PLANS_MANAGE],
    params: idParam,
    body: updatePlanBody,
    response: planSchema,
    errors: [404],
    handler: async ({ res, params, body, actor, client }) =>
      sendSuccess(res, await plansService.update(params.id, body, { userId: actor().userId, client })),
  });

export const plansRouter = api.router;
