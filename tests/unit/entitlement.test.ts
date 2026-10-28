import { describe, expect, it } from 'vitest';
import { canAccessTier, checkAge, evaluateEntitlement } from '../../src/modules/subscriptions/entitlement.js';

const now = new Date('2026-06-15T12:00:00Z');
const activeSub = {
  status: 'ACTIVE' as const,
  currentPeriodStart: new Date('2026-06-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
  features: ['PRO_CONTENT', 'HD_QUALITY'],
  latestPaymentStatus: 'SUCCEEDED' as const,
};

describe('evaluateEntitlement', () => {
  it('grants Pro for an active subscription within its period', () => {
    const e = evaluateEntitlement({ userStatus: 'ACTIVE', subscription: activeSub, now });
    expect(e).toMatchObject({ isPro: true, reason: 'ACTIVE', features: ['PRO_CONTENT', 'HD_QUALITY'] });
    expect(e.validUntil?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('denies access exactly at period end even if the status is still ACTIVE (job not run yet)', () => {
    const e = evaluateEntitlement({ userStatus: 'ACTIVE', subscription: activeSub, now: activeSub.currentPeriodEnd });
    expect(e).toMatchObject({ isPro: false, reason: 'PERIOD_ENDED' });
  });

  it.each(['PENDING', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'SUSPENDED'] as const)('denies %s subscriptions', (status) => {
    expect(evaluateEntitlement({ userStatus: 'ACTIVE', subscription: { ...activeSub, status }, now }).isPro).toBe(false);
  });

  it('denies blocked users even with a paid subscription', () => {
    expect(evaluateEntitlement({ userStatus: 'BANNED', subscription: activeSub, now })).toMatchObject({ isPro: false, reason: 'USER_BLOCKED' });
  });

  it('denies when the funding payment was refunded', () => {
    const e = evaluateEntitlement({ userStatus: 'ACTIVE', subscription: { ...activeSub, latestPaymentStatus: 'REFUNDED' }, now });
    expect(e).toMatchObject({ isPro: false, reason: 'PAYMENT_REVERSED' });
  });

  it('does not grant Pro for plans without the PRO_CONTENT feature', () => {
    const e = evaluateEntitlement({ userStatus: 'ACTIVE', subscription: { ...activeSub, features: ['NO_ADS'] }, now });
    expect(e.isPro).toBe(false);
    expect(canAccessTier(e, 'PRO')).toBe(false);
    expect(canAccessTier(e, 'FREE')).toBe(true);
  });

  it('returns NO_SUBSCRIPTION without a subscription', () => {
    expect(evaluateEntitlement({ userStatus: 'ACTIVE', subscription: null, now }).reason).toBe('NO_SUBSCRIPTION');
  });
});

describe('checkAge', () => {
  it('allows ALL rating without a birth date', () => {
    expect(checkAge(null, 'ALL', now).allowed).toBe(true);
  });
  it('requires a birth date for 18+ titles', () => {
    expect(checkAge(null, 'AGE_18', now)).toEqual({ allowed: false, minAge: 18 });
  });
  it('blocks a viewer one day before their 18th birthday and allows on the birthday', () => {
    expect(checkAge(new Date('2008-06-16'), 'AGE_18', now).allowed).toBe(false);
    expect(checkAge(new Date('2008-06-15'), 'AGE_18', now).allowed).toBe(true);
  });
  it('blocks a known 10-year-old from AGE_12 content', () => {
    expect(checkAge(new Date('2016-01-01'), 'AGE_12', now).allowed).toBe(false);
  });
});
