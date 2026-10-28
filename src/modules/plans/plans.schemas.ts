import { z } from 'zod';
import { ALL_PLAN_FEATURES } from '../../common/constants/features.js';
import { currencyCode } from '../../common/utils/schemas.js';
import { slugInput } from '../../common/utils/content.js';

export const BILLING_INTERVALS = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const;

export const createPlanBody = z.object({
  name: z.string().trim().min(2).max(100),
  slug: slugInput,
  description: z.string().trim().max(1000).nullable().optional(),
  priceMinor: z.number().int().min(0).max(100_000_000).describe('Price in minor currency units (e.g. 999 = $9.99)'),
  currency: currencyCode,
  billingInterval: z.enum(BILLING_INTERVALS),
  intervalCount: z.number().int().min(1).max(36).default(1),
  trialDays: z.number().int().min(0).max(90).default(0),
  features: z.array(z.enum(ALL_PLAN_FEATURES)).max(20).default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
export const updatePlanBody = createPlanBody.partial().omit({ slug: true });

export const planSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  priceMinor: z.number().int(),
  currency: z.string(),
  formattedPrice: z.string(),
  billingInterval: z.enum(BILLING_INTERVALS),
  intervalCount: z.number().int(),
  trialDays: z.number().int(),
  features: z.array(z.string()),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});
