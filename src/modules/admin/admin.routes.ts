import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendSuccess } from '../../common/http/response.js';
import { dateRangeQuery } from '../../common/utils/schemas.js';
import { env } from '../../config/env.js';
import { analyticsService, resolveRange } from '../analytics/analytics.service.js';

const api = new ApiRouter('Admin · Dashboard');

const rangeQuery = dateRangeQuery.and(
  z.object({ mode: z.enum(['live', 'test']).optional().describe('Defaults to the server PAYMENT_MODE') }),
);
const seriesQuery = rangeQuery.and(z.object({ interval: z.enum(['day', 'week', 'month']).default('day') }));
const livemode = (mode?: 'live' | 'test') => (mode ?? env.PAYMENT_MODE) === 'live';

const revenueRow = z.object({
  currency: z.string(),
  grossMinor: z.number().int(),
  refundsMinor: z.number().int(),
  netMinor: z.number().int(),
  formattedNet: z.string(),
  payments: z.number().int(),
});

api
  .route({
    method: 'get',
    path: '/admin/dashboard',
    summary: 'Dashboard overview for a date range (default: last 30 days)',
    description:
      'Revenue = live-mode payments with status SUCCEEDED/PARTIALLY_REFUNDED/REFUNDED by paid date; net = gross − refunded; reported per currency, never mixed.',
    permissions: [PERMISSIONS.ANALYTICS_READ],
    query: rangeQuery,
    response: z.object({
      range: z.object({ from: z.string(), to: z.string() }),
      livemode: z.boolean(),
      users: z.object({ total: z.number().int(), activeInRange: z.number().int(), newInRange: z.number().int() }),
      subscriptions: z.object({ activePro: z.number().int() }),
      revenue: z.array(revenueRow),
      payments: z.object({ succeeded: z.number().int(), failed: z.number().int(), refunded: z.number().int(), byStatus: z.record(z.string(), z.number()) }),
      catalog: z.object({ movies: z.record(z.string(), z.number()), seriesTotal: z.number().int() }),
      topMovies: z.object({ popular: z.array(z.record(z.string(), z.unknown())), mostWatched: z.array(z.record(z.string(), z.unknown())) }),
      recentUsers: z.array(z.record(z.string(), z.unknown())),
      recentPayments: z.array(z.record(z.string(), z.unknown())),
    }),
    handler: async ({ res, query }) => sendSuccess(res, await analyticsService.dashboard(resolveRange(query.from, query.to), livemode(query.mode))),
  })
  .route({
    method: 'get',
    path: '/admin/analytics/revenue',
    summary: 'Revenue time series per currency',
    permissions: [PERMISSIONS.ANALYTICS_READ],
    query: seriesQuery,
    response: z.array(z.object({ bucket: z.string(), currency: z.string(), grossMinor: z.number(), refundsMinor: z.number(), netMinor: z.number(), payments: z.number() })),
    handler: async ({ res, query }) =>
      sendSuccess(res, await analyticsService.revenueSeries(resolveRange(query.from, query.to), query.interval, livemode(query.mode))),
  })
  .route({
    method: 'get',
    path: '/admin/analytics/signups',
    summary: 'Sign-ups time series',
    permissions: [PERMISSIONS.ANALYTICS_READ],
    query: seriesQuery,
    response: z.array(z.object({ bucket: z.string(), count: z.number() })),
    handler: async ({ res, query }) => sendSuccess(res, await analyticsService.signupSeries(resolveRange(query.from, query.to), query.interval)),
  });

export const adminRouter = api.router;
