/** Feature flags a subscription plan can grant. Stored in SubscriptionPlan.features. */
export const PLAN_FEATURES = {
  PRO_CONTENT: 'PRO_CONTENT',
  HD_QUALITY: 'HD_QUALITY',
  NO_ADS: 'NO_ADS',
  MULTI_DEVICE: 'MULTI_DEVICE',
} as const;

export type PlanFeature = (typeof PLAN_FEATURES)[keyof typeof PLAN_FEATURES];
export const ALL_PLAN_FEATURES = Object.values(PLAN_FEATURES) as [PlanFeature, ...PlanFeature[]];

export const AGE_RATING_MIN_AGE = {
  ALL: 0,
  AGE_6: 6,
  AGE_12: 12,
  AGE_16: 16,
  AGE_18: 18,
} as const;
