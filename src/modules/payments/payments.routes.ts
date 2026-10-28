import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendSuccess } from '../../common/http/response.js';
import { paginationQuery } from '../../common/utils/pagination.js';
import { idParam } from '../../common/utils/schemas.js';
import { paymentsService } from './payments.service.js';

const api = new ApiRouter('Billing · Payments');
const admin = 'Admin · Billing';

const PAYMENT_STATUSES = ['PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

const paymentSchema = z.object({
  id: z.uuid(),
  subscriptionId: z.uuid().nullable(),
  provider: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  amountMinor: z.number().int(),
  discountMinor: z.number().int(),
  refundedMinor: z.number().int(),
  currency: z.string(),
  formattedAmount: z.string(),
  livemode: z.boolean(),
  paidAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  refundedAt: z.string().nullable(),
  failureCode: z.string().nullable(),
  kind: z.string().nullable(),
  createdAt: z.string(),
});
const userRef = z.object({ id: z.uuid(), email: z.string() });

api
  .route({
    method: 'get',
    path: '/me/payments',
    summary: 'My payment history',
    auth: 'user',
    query: paginationQuery,
    response: paymentSchema,
    paginated: true,
    handler: async ({ res, query, actor }) => {
      const { items, meta } = await paymentsService.listMine(actor().userId, query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'get',
    path: '/admin/payments',
    tags: [admin],
    summary: 'List payments',
    permissions: [PERMISSIONS.PAYMENTS_READ],
    query: paginationQuery.extend({
      status: z.enum(PAYMENT_STATUSES).optional(),
      userId: z.uuid().optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
    }),
    response: paymentSchema.extend({ user: userRef }),
    paginated: true,
    handler: async ({ res, query }) => {
      const { items, meta } = await paymentsService.adminList(query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'get',
    path: '/admin/payments/:id',
    tags: [admin],
    summary: 'Payment details',
    permissions: [PERMISSIONS.PAYMENTS_READ],
    params: idParam,
    response: paymentSchema.extend({ user: userRef, providerPaymentId: z.string().nullable(), couponCode: z.string().nullable() }),
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await paymentsService.adminGet(params.id)),
  })
  .route({
    method: 'post',
    path: '/admin/payments/:id/refund',
    tags: [admin],
    summary: 'Refund a payment through the provider',
    description: 'Omit `amountMinor` for a full refund. Local status updates when the provider confirms via webhook.',
    permissions: [PERMISSIONS.PAYMENTS_REFUND],
    params: idParam,
    body: z.object({ amountMinor: z.number().int().min(1).optional(), reason: z.string().trim().min(3).max(500) }),
    response: z.object({ refundId: z.string(), status: z.string(), amountMinor: z.number().int(), currency: z.string() }),
    errors: [404, 409, 502],
    handler: async ({ res, params, body, actor, client }) => sendSuccess(res, await paymentsService.refund(actor(), params.id, body, client), { message: 'Refund requested' }),
  });

export const paymentsRouter = api.router;
