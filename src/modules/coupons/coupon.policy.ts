import type { Coupon } from '@prisma/client';
import { percentOf } from '../../common/utils/money.js';

export type CouponRejection =
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'PLAN_NOT_ELIGIBLE'
  | 'CURRENCY_MISMATCH'
  | 'MIN_AMOUNT_NOT_MET'
  | 'GLOBAL_LIMIT_REACHED'
  | 'USER_LIMIT_REACHED';

export const COUPON_REJECTION_MESSAGES: Record<CouponRejection, string> = {
  INACTIVE: 'This coupon is not active',
  NOT_STARTED: 'This coupon is not valid yet',
  EXPIRED: 'This coupon has expired',
  PLAN_NOT_ELIGIBLE: 'This coupon does not apply to the selected plan',
  CURRENCY_MISMATCH: 'This coupon does not apply to the plan currency',
  MIN_AMOUNT_NOT_MET: 'The order amount is below the coupon minimum',
  GLOBAL_LIMIT_REACHED: 'This coupon has reached its usage limit',
  USER_LIMIT_REACHED: 'You have already used this coupon',
};

export interface CouponContext {
  plan: { id: string; priceMinor: number; currency: string };
  eligiblePlanIds: string[]; // empty = all plans
  usedTotal: number; // RESERVED + REDEEMED
  usedByUser: number;
  now: Date;
}

export type CouponEvaluation =
  | { ok: true; discountMinor: number; finalMinor: number; currency: string }
  | { ok: false; reason: CouponRejection };

/** Pure coupon evaluation in integer minor units. The discount never exceeds the plan price. */
export function evaluateCoupon(coupon: Pick<Coupon, 'isActive' | 'startsAt' | 'endsAt' | 'discountType' | 'percentOff' | 'amountOffMinor' | 'currency' | 'maxRedemptions' | 'perUserLimit' | 'minAmountMinor'>, ctx: CouponContext): CouponEvaluation {
  const { plan, now } = ctx;
  if (!coupon.isActive) return { ok: false, reason: 'INACTIVE' };
  if (coupon.startsAt && now < coupon.startsAt) return { ok: false, reason: 'NOT_STARTED' };
  if (coupon.endsAt && now >= coupon.endsAt) return { ok: false, reason: 'EXPIRED' };
  if (ctx.eligiblePlanIds.length && !ctx.eligiblePlanIds.includes(plan.id)) return { ok: false, reason: 'PLAN_NOT_ELIGIBLE' };
  if (coupon.discountType === 'FIXED' && coupon.currency !== plan.currency) return { ok: false, reason: 'CURRENCY_MISMATCH' };
  if (coupon.minAmountMinor !== null && plan.priceMinor < coupon.minAmountMinor) return { ok: false, reason: 'MIN_AMOUNT_NOT_MET' };
  if (coupon.maxRedemptions !== null && ctx.usedTotal >= coupon.maxRedemptions) return { ok: false, reason: 'GLOBAL_LIMIT_REACHED' };
  if (ctx.usedByUser >= coupon.perUserLimit) return { ok: false, reason: 'USER_LIMIT_REACHED' };

  const raw = coupon.discountType === 'PERCENT' ? percentOf(plan.priceMinor, coupon.percentOff ?? 0) : (coupon.amountOffMinor ?? 0);
  const discountMinor = Math.min(raw, plan.priceMinor);
  return { ok: true, discountMinor, finalMinor: plan.priceMinor - discountMinor, currency: plan.currency };
}
