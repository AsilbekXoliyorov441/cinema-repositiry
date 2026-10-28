import type { AccessTier, AgeRating, PaymentStatus, SubscriptionStatus, UserStatus } from '@prisma/client';
import { AGE_RATING_MIN_AGE, PLAN_FEATURES, type PlanFeature } from '../../common/constants/features.js';

export interface EntitlementInput {
  userStatus: UserStatus;
  subscription: {
    status: SubscriptionStatus;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    features: string[];
    latestPaymentStatus: PaymentStatus | null;
  } | null;
  now: Date;
}

export type EntitlementReason =
  | 'ACTIVE'
  | 'NO_SUBSCRIPTION'
  | 'USER_BLOCKED'
  | 'SUBSCRIPTION_NOT_ACTIVE'
  | 'PERIOD_NOT_STARTED'
  | 'PERIOD_ENDED'
  | 'PAYMENT_REVERSED';

export interface Entitlement {
  isPro: boolean;
  features: PlanFeature[];
  reason: EntitlementReason;
  validUntil: Date | null;
}

const NONE = (reason: EntitlementReason): Entitlement => ({ isPro: false, features: [], reason, validUntil: null });

/**
 * Pure entitlement evaluation — the single source of truth for premium access.
 * Time is checked here, so access ends exactly at currentPeriodEnd even if the expiry job has not run yet.
 */
export function evaluateEntitlement({ userStatus, subscription: s, now }: EntitlementInput): Entitlement {
  if (userStatus !== 'ACTIVE') return NONE('USER_BLOCKED');
  if (!s) return NONE('NO_SUBSCRIPTION');
  if (s.status !== 'ACTIVE') return NONE('SUBSCRIPTION_NOT_ACTIVE');
  if (!s.currentPeriodEnd || !s.currentPeriodStart) return NONE('SUBSCRIPTION_NOT_ACTIVE');
  if (now < s.currentPeriodStart) return NONE('PERIOD_NOT_STARTED');
  if (now >= s.currentPeriodEnd) return NONE('PERIOD_ENDED');
  if (s.latestPaymentStatus === 'REFUNDED' || s.latestPaymentStatus === 'CANCELED') return NONE('PAYMENT_REVERSED');

  const features = s.features.filter((f): f is PlanFeature => (Object.values(PLAN_FEATURES) as string[]).includes(f));
  return { isPro: features.includes(PLAN_FEATURES.PRO_CONTENT), features, reason: 'ACTIVE', validUntil: s.currentPeriodEnd };
}

export function canAccessTier(entitlement: Entitlement, tier: AccessTier): boolean {
  return tier === 'FREE' || entitlement.features.includes(PLAN_FEATURES.PRO_CONTENT);
}

export function hasFeature(entitlement: Entitlement, feature: PlanFeature): boolean {
  return entitlement.features.includes(feature);
}

export function ageOn(birthDate: Date, now: Date): number {
  let age = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const m = now.getUTCMonth() - birthDate.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birthDate.getUTCDate())) age--;
  return age;
}

/**
 * Age gate: 18+ content requires a known birth date proving adulthood; for lower ratings
 * a known birth date below the minimum blocks playback.
 */
export function checkAge(birthDate: Date | null, rating: AgeRating, now = new Date()): { allowed: boolean; minAge: number } {
  const minAge = AGE_RATING_MIN_AGE[rating];
  if (minAge === 0) return { allowed: true, minAge };
  if (!birthDate) return { allowed: minAge < 18, minAge };
  return { allowed: ageOn(birthDate, now) >= minAge, minAge };
}
