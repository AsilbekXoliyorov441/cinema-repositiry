import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { rateLimiters } from '../../common/middleware/rate-limit.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { paginationQuery } from '../../common/utils/pagination.js';
import { idParam } from '../../common/utils/schemas.js';
import { planSchema } from '../plans/plans.schemas.js';
import { subscriptionsService } from './subscriptions.service.js';
import * as S from './subscriptions.schemas.js';

const api = new ApiRouter('Billing · Subscriptions');
const admin = 'Admin · Billing';

api
  .route({
    method: 'get',
    path: '/me/subscription',
    summary: 'My current subscription and Pro entitlement',
    auth: 'user',
    response: S.currentSubscriptionSchema,
    handler: async ({ res, actor }) => sendSuccess(res, await subscriptionsService.current(actor().userId)),
  })
  .route({
    method: 'get',
    path: '/me/subscriptions',
    summary: 'My subscription history',
    auth: 'user',
    query: paginationQuery,
    response: S.subscriptionSchema,
    paginated: true,
    handler: async ({ res, query, actor }) => {
      const { items, meta } = await subscriptionsService.history(actor().userId, query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'post',
    path: '/subscriptions/checkout',
    summary: 'Start a checkout for a plan',
    description:
      'Price is taken from the database (never from the client). Returns a provider-hosted checkout URL. ' +
      'The subscription stays PENDING until the provider webhook confirms payment — the success redirect does NOT activate it. ' +
      'Send an `Idempotency-Key` header to safely retry. Requires a verified email.',
    requireVerifiedEmail: true,
    rateLimit: rateLimiters.checkout,
    body: S.checkoutBody,
    response: S.checkoutResponse,
    responseStatus: 201,
    errors: [404, 409, 503],
    handler: async ({ req, res, body, actor, client }) => {
      const key = req.get('idempotency-key');
      const idempotencyKey = key && /^[A-Za-z0-9_-]{8,100}$/.test(key) ? key : undefined;
      sendCreated(res, await subscriptionsService.startCheckout(actor(), body, idempotencyKey, client), 'Checkout created');
    },
  })
  .route({
    method: 'post',
    path: '/me/subscription/cancel',
    summary: 'Cancel my subscription',
    description: '`atPeriodEnd: true` (default) turns off auto-renewal and keeps access until the period ends.',
    auth: 'user',
    body: S.cancelBody,
    response: S.subscriptionSchema,
    errors: [404, 409],
    handler: async ({ res, body, actor, client }) => sendSuccess(res, await subscriptionsService.cancel(actor(), body, client), { message: 'Subscription canceled' }),
  })
  .route({
    method: 'post',
    path: '/me/subscription/resume',
    summary: 'Turn auto-renewal back on',
    auth: 'user',
    response: S.subscriptionSchema,
    errors: [404, 409],
    handler: async ({ res, actor, client }) => sendSuccess(res, await subscriptionsService.resume(actor(), client), { message: 'Auto-renewal enabled' }),
  })
  .route({
    method: 'post',
    path: '/me/subscription/change-plan',
    summary: 'Switch to another plan (prorated by the provider)',
    description: 'The new plan becomes effective when the provider confirms the change via webhook.',
    auth: 'user',
    body: S.changePlanBody,
    response: z.object({ status: z.literal('PENDING_CONFIRMATION'), requestedPlan: planSchema, subscription: S.subscriptionSchema }),
    errors: [404, 409],
    handler: async ({ res, body, actor, client }) => sendSuccess(res, await subscriptionsService.changePlan(actor(), body.planId, client)),
  })
  // ───── Admin ─────
  .route({
    method: 'get',
    path: '/admin/subscriptions',
    tags: [admin],
    summary: 'List subscriptions',
    permissions: [PERMISSIONS.SUBSCRIPTIONS_READ],
    query: S.adminSubscriptionsQuery,
    response: S.adminSubscriptionSchema,
    paginated: true,
    handler: async ({ res, query }) => {
      const { items, meta } = await subscriptionsService.adminList(query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'get',
    path: '/admin/subscriptions/:id',
    tags: [admin],
    summary: 'Subscription details with payments',
    permissions: [PERMISSIONS.SUBSCRIPTIONS_READ],
    params: idParam,
    response: S.adminSubscriptionDetailSchema,
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await subscriptionsService.adminGet(params.id)),
  })
  .route({
    method: 'post',
    path: '/admin/subscriptions/grant',
    tags: [admin],
    summary: 'Grant a manual subscription (reason required, audited)',
    permissions: [PERMISSIONS.SUBSCRIPTIONS_MANAGE],
    body: S.grantBody,
    response: S.subscriptionSchema,
    responseStatus: 201,
    errors: [404, 409],
    handler: async ({ res, body, actor, client }) => sendCreated(res, await subscriptionsService.grant(actor(), body, client)),
  })
  .route({
    method: 'post',
    path: '/admin/subscriptions/:id/extend',
    tags: [admin],
    summary: 'Extend a manual subscription',
    permissions: [PERMISSIONS.SUBSCRIPTIONS_MANAGE],
    params: idParam,
    body: S.extendBody,
    response: S.subscriptionSchema,
    errors: [404, 409],
    handler: async ({ res, params, body, actor, client }) => sendSuccess(res, await subscriptionsService.extend(actor(), params.id, body, client)),
  })
  .route({
    method: 'post',
    path: '/admin/subscriptions/:id/status',
    tags: [admin],
    summary: 'Suspend, reinstate or cancel a subscription',
    permissions: [PERMISSIONS.SUBSCRIPTIONS_MANAGE],
    params: idParam,
    body: S.adminStatusBody,
    response: S.subscriptionSchema,
    errors: [404, 409],
    handler: async ({ res, params, body, actor, client }) =>
      sendSuccess(res, await subscriptionsService.adminSetStatus(actor(), params.id, body.status, body.reason, client)),
  });

export const subscriptionsRouter = api.router;
