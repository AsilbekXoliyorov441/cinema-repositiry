import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { idParam } from '../../common/utils/schemas.js';
import { plansService } from '../plans/plans.service.js';
import { couponsService } from './coupons.service.js';
import * as S from './coupons.schemas.js';

const api = new ApiRouter('Billing · Coupons');
const admin = 'Admin · Billing';

api
  .route({
    method: 'post',
    path: '/coupons/validate',
    summary: 'Preview a coupon for a plan',
    description: 'Informational only — the coupon is re-validated and reserved atomically during checkout.',
    auth: 'user',
    body: S.validateCouponBody,
    response: S.couponPreviewSchema,
    errors: [404],
    handler: async ({ res, body, actor }) => {
      const plan = await plansService.getPurchasable(body.planId);
      sendSuccess(res, await couponsService.preview(actor().userId, body.code, plan));
    },
  })
  .route({
    method: 'get',
    path: '/admin/coupons',
    tags: [admin],
    summary: 'List coupons',
    permissions: [PERMISSIONS.COUPONS_MANAGE],
    query: S.listCouponsQuery,
    response: S.couponSchema,
    paginated: true,
    handler: async ({ res, query }) => {
      const { items, meta } = await couponsService.list(query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'post',
    path: '/admin/coupons',
    tags: [admin],
    summary: 'Create coupon',
    permissions: [PERMISSIONS.COUPONS_MANAGE],
    body: S.createCouponBody,
    response: S.couponSchema,
    responseStatus: 201,
    errors: [409],
    handler: async ({ res, body, actor, client }) => sendCreated(res, await couponsService.create(body, { userId: actor().userId, client })),
  })
  .route({
    method: 'get',
    path: '/admin/coupons/:id',
    tags: [admin],
    summary: 'Coupon details',
    permissions: [PERMISSIONS.COUPONS_MANAGE],
    params: idParam,
    response: S.couponSchema,
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await couponsService.get(params.id)),
  })
  .route({
    method: 'patch',
    path: '/admin/coupons/:id',
    tags: [admin],
    summary: 'Update or deactivate coupon',
    description: 'Discount type and amount are immutable once created; create a new coupon instead.',
    permissions: [PERMISSIONS.COUPONS_MANAGE],
    params: idParam,
    body: S.updateCouponBody,
    response: S.couponSchema,
    errors: [404],
    handler: async ({ res, params, body, actor, client }) => sendSuccess(res, await couponsService.update(params.id, body, { userId: actor().userId, client })),
  });

export const couponsRouter = api.router;
