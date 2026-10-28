import { z } from 'zod';
import { paginationQuery } from '../../common/utils/pagination.js';
import { currencyCode } from '../../common/utils/schemas.js';

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_-]{3,50}$/, '3-50 characters: letters, digits, dash, underscore');

const couponFields = z.object({
  code,
  description: z.string().trim().max(255).nullable().optional(),
  discountType: z.enum(['PERCENT', 'FIXED']),
  percentOff: z.number().int().min(1).max(100).nullable().optional(),
  amountOffMinor: z.number().int().min(1).max(100_000_000).nullable().optional(),
  currency: currencyCode.nullable().optional(),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  perUserLimit: z.number().int().min(1).max(100).default(1),
  minAmountMinor: z.number().int().min(0).nullable().optional(),
  isActive: z.boolean().default(true),
  planIds: z.array(z.uuid()).max(50).default([]).describe('Empty = all plans'),
});

export const createCouponBody = couponFields.superRefine((v, ctx) => {
  if (v.discountType === 'PERCENT' && !v.percentOff) ctx.addIssue({ code: 'custom', path: ['percentOff'], message: 'Required for PERCENT coupons' });
  if (v.discountType === 'FIXED' && (!v.amountOffMinor || !v.currency)) {
    ctx.addIssue({ code: 'custom', path: ['amountOffMinor'], message: 'amountOffMinor and currency are required for FIXED coupons' });
  }
  if (v.startsAt && v.endsAt && v.startsAt >= v.endsAt) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Must be after startsAt' });
});

export const updateCouponBody = couponFields
  .pick({ description: true, startsAt: true, endsAt: true, maxRedemptions: true, perUserLimit: true, minAmountMinor: true, isActive: true, planIds: true })
  .partial();

export const validateCouponBody = z.object({ code, planId: z.uuid() });
export const listCouponsQuery = paginationQuery.extend({ active: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });

export const couponSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  description: z.string().nullable(),
  discountType: z.enum(['PERCENT', 'FIXED']),
  percentOff: z.number().int().nullable(),
  amountOffMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  maxRedemptions: z.number().int().nullable(),
  perUserLimit: z.number().int(),
  minAmountMinor: z.number().int().nullable(),
  isActive: z.boolean(),
  planIds: z.array(z.uuid()),
  redeemedCount: z.number().int(),
  reservedCount: z.number().int(),
});

export const couponPreviewSchema = z.object({
  code: z.string(),
  valid: z.boolean(),
  reason: z.string().nullable(),
  priceMinor: z.number().int(),
  discountMinor: z.number().int(),
  finalMinor: z.number().int(),
  currency: z.string(),
});
