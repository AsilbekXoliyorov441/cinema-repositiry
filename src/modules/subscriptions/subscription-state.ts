import type { PaymentStatus, SubscriptionStatus } from '@prisma/client';
import { AppError } from '../../common/errors/app-error.js';

/**
 * Subscription lifecycle.
 *
 *   PENDING ──(first payment confirmed by webhook)──▶ ACTIVE
 *   PENDING ──(checkout expired/abandoned)──────────▶ EXPIRED
 *   ACTIVE  ──(renewal paid)────────────────────────▶ ACTIVE (period extended)
 *   ACTIVE  ──(renewal payment failed)──────────────▶ PAST_DUE
 *   PAST_DUE──(retry succeeded)─────────────────────▶ ACTIVE
 *   ACTIVE/PAST_DUE ──(refund / chargeback / admin)─▶ SUSPENDED
 *   SUSPENDED ──(admin reinstates / dispute won)────▶ ACTIVE
 *   any open ──(immediate cancel / provider ends it)▶ CANCELED   (terminal)
 *   any open ──(period ended without renewal)───────▶ EXPIRED    (terminal)
 *
 * "Cancel at period end" keeps ACTIVE with cancelAtPeriodEnd=true until the period ends.
 */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  PENDING: ['ACTIVE', 'CANCELED', 'EXPIRED'],
  ACTIVE: ['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED', 'EXPIRED'],
  PAST_DUE: ['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED', 'EXPIRED'],
  SUSPENDED: ['ACTIVE', 'CANCELED', 'EXPIRED'],
  CANCELED: [],
  EXPIRED: [],
};

export const OPEN_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['PENDING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'];

export function canTransitionSubscription(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

export function assertSubscriptionTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (!canTransitionSubscription(from, to)) {
    throw AppError.conflict(`Subscription cannot move from ${from} to ${to}`);
  }
}

/**
 * Payment lifecycle. FAILED → SUCCEEDED is allowed because providers retry the same invoice.
 * REFUNDED and CANCELED are terminal.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ['REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELED'],
  REQUIRES_ACTION: ['SUCCEEDED', 'FAILED', 'CANCELED'],
  FAILED: ['SUCCEEDED', 'FAILED', 'CANCELED'],
  SUCCEEDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  REFUNDED: [],
  CANCELED: [],
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}
