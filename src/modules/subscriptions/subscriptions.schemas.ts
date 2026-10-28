import { z } from 'zod';
import { paginationQuery } from '../../common/utils/pagination.js';
import { planSchema } from '../plans/plans.schemas.js';

export const SUBSCRIPTION_STATUSES = ['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'SUSPENDED'] as const;

export const checkoutBody = z.object({
  planId: z.uuid(),
  couponCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,50}$/)
    .optional(),
});
export const cancelBody = z.object({ atPeriodEnd: z.boolean().default(true) });
export const changePlanBody = z.object({ planId: z.uuid() });

export const adminSubscriptionsQuery = paginationQuery.extend({ status: z.enum(SUBSCRIPTION_STATUSES).optional(), userId: z.uuid().optional() });
export const grantBody = z.object({ userId: z.uuid(), planId: z.uuid(), days: z.number().int().min(1).max(3650), reason: z.string().trim().min(3).max(500) });
export const extendBody = z.object({ days: z.number().int().min(1).max(3650), reason: z.string().trim().min(3).max(500) });
export const adminStatusBody = z.object({ status: z.enum(['SUSPENDED', 'ACTIVE', 'CANCELED']), reason: z.string().trim().min(3).max(500) });

export const subscriptionSchema = z.object({
  id: z.uuid(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  plan: planSchema,
  provider: z.string(),
  startsAt: z.string().nullable(),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  canceledAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const currentSubscriptionSchema = z.object({
  subscription: subscriptionSchema.nullable(),
  entitlement: z.object({ isPro: z.boolean(), features: z.array(z.string()), reason: z.string(), validUntil: z.string().nullable() }),
});

export const checkoutResponse = z.object({
  checkoutUrl: z.url().describe('Redirect the user here (provider-hosted payment page)'),
  subscriptionId: z.uuid().nullable(),
  paymentId: z.uuid(),
  expiresAt: z.string().nullable(),
});

const userRef = z.object({ id: z.uuid(), email: z.string(), displayName: z.string() });
export const adminSubscriptionSchema = subscriptionSchema.extend({ user: userRef, statusReason: z.string().nullable() });
export const adminSubscriptionDetailSchema = adminSubscriptionSchema.extend({
  providerSubscriptionId: z.string().nullable(),
  payments: z.array(z.object({ id: z.uuid(), status: z.string(), amountMinor: z.number().int(), refundedMinor: z.number().int(), currency: z.string(), paidAt: z.string().nullable() })),
});
