import { describe, expect, it } from 'vitest';
import { evaluateCoupon } from '../../src/modules/coupons/coupon.policy.js';
import { formatMoney, percentOf } from '../../src/common/utils/money.js';

const base = {
  isActive: true,
  startsAt: null,
  endsAt: null,
  discountType: 'PERCENT' as const,
  percentOff: 25,
  amountOffMinor: null,
  currency: null,
  maxRedemptions: null,
  perUserLimit: 1,
  minAmountMinor: null,
};
const ctx = { plan: { id: 'p1', priceMinor: 799, currency: 'USD' }, eligiblePlanIds: [], usedTotal: 0, usedByUser: 0, now: new Date('2026-06-01') };

describe('percentOf', () => {
  it('rounds half up in integer minor units', () => {
    expect(percentOf(799, 25)).toBe(200); // 199.75 → 200
    expect(percentOf(1000, 33)).toBe(330);
    expect(percentOf(1, 50)).toBe(1); // 0.5 → 1
  });
  it('never exceeds the amount and rejects invalid input', () => {
    expect(percentOf(500, 100)).toBe(500);
    expect(() => percentOf(10.5, 10)).toThrow();
    expect(() => percentOf(100, 101)).toThrow();
  });
});

describe('formatMoney', () => {
  it('formats minor units per currency', () => {
    expect(formatMoney(799, 'USD')).toBe('$7.99');
    expect(formatMoney(500, 'JPY')).toBe('¥500');
  });
});

describe('evaluateCoupon', () => {
  it('applies a percent discount', () => {
    expect(evaluateCoupon(base, ctx)).toEqual({ ok: true, discountMinor: 200, finalMinor: 599, currency: 'USD' });
  });
  it('caps fixed discounts at the plan price', () => {
    const r = evaluateCoupon({ ...base, discountType: 'FIXED', percentOff: null, amountOffMinor: 5000, currency: 'USD' }, ctx);
    expect(r).toEqual({ ok: true, discountMinor: 799, finalMinor: 0, currency: 'USD' });
  });
  it('rejects fixed coupons in another currency', () => {
    const r = evaluateCoupon({ ...base, discountType: 'FIXED', percentOff: null, amountOffMinor: 100, currency: 'EUR' }, ctx);
    expect(r).toEqual({ ok: false, reason: 'CURRENCY_MISMATCH' });
  });
  it.each([
    [{ isActive: false }, {}, 'INACTIVE'],
    [{ startsAt: new Date('2026-07-01') }, {}, 'NOT_STARTED'],
    [{ endsAt: new Date('2026-06-01') }, {}, 'EXPIRED'],
    [{}, { eligiblePlanIds: ['other'] }, 'PLAN_NOT_ELIGIBLE'],
    [{ minAmountMinor: 1000 }, {}, 'MIN_AMOUNT_NOT_MET'],
    [{ maxRedemptions: 5 }, { usedTotal: 5 }, 'GLOBAL_LIMIT_REACHED'],
    [{}, { usedByUser: 1 }, 'USER_LIMIT_REACHED'],
  ])('rejects %o / %o with %s', (coupon, context, reason) => {
    expect(evaluateCoupon({ ...base, ...coupon }, { ...ctx, ...context })).toEqual({ ok: false, reason });
  });
});
