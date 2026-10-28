import type { BillingInterval, PaymentProviderName } from '@prisma/client';

export interface ProviderPlan {
  id: string;
  name: string;
  priceMinor: number;
  currency: string;
  billingInterval: BillingInterval;
  intervalCount: number;
}

export interface CheckoutRequest {
  customerId: string;
  priceId: string;
  localSubscriptionId: string;
  paymentId: string;
  userId: string;
  idempotencyKey: string;
  discount: { amountMinor: number; currency: string } | null;
  trialDays: number;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
}

export interface CheckoutSession {
  checkoutId: string;
  url: string;
  expiresAt: Date;
}

export type ProviderSubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';

export interface ProviderSubscriptionState {
  providerSubscriptionId: string;
  status: ProviderSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  priceId: string | null;
  localSubscriptionId: string | null;
}

/**
 * Provider-agnostic billing events. Adapters translate their native webhook payloads into these,
 * so subscription/payment business logic never depends on a specific provider's schema.
 */
export type BillingEventPayload =
  | { kind: 'checkout.completed'; checkoutId: string; providerSubscriptionId: string | null; localSubscriptionId: string | null }
  | { kind: 'checkout.expired'; checkoutId: string; localSubscriptionId: string | null }
  | {
      kind: 'invoice.paid';
      invoiceId: string;
      providerSubscriptionId: string;
      localSubscriptionId: string | null;
      amountPaidMinor: number;
      currency: string;
      periodStart: Date;
      periodEnd: Date;
      chargeRef: string | null;
      isFirstInvoice: boolean;
    }
  | {
      kind: 'invoice.payment_failed';
      invoiceId: string;
      providerSubscriptionId: string;
      localSubscriptionId: string | null;
      amountDueMinor: number;
      currency: string;
      failureCode: string | null;
      isFirstInvoice: boolean;
    }
  | { kind: 'subscription.updated'; state: ProviderSubscriptionState }
  | { kind: 'subscription.deleted'; providerSubscriptionId: string; endedAt: Date }
  | { kind: 'charge.refunded'; chargeRef: string; amountMinor: number; amountRefundedMinor: number; currency: string }
  | { kind: 'charge.dispute_created'; chargeRef: string }
  | { kind: 'ignored' };

export interface BillingEvent {
  id: string;
  type: string;
  livemode: boolean;
  payload: BillingEventPayload;
}

/**
 * Contract every payment provider adapter implements. Only Stripe is implemented today;
 * see docs/payments-integration.md for Click/Payme guidance.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName;
  readonly livemode: boolean;
  createCustomer(user: { id: string; email: string; name: string }): Promise<string>;
  createPrice(plan: ProviderPlan): Promise<string>;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  /** Verifies the signature and returns a normalized event. Throws AppError(WEBHOOK_SIGNATURE_INVALID). */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<BillingEvent>;
  cancelSubscription(providerSubscriptionId: string, options: { atPeriodEnd: boolean }): Promise<void>;
  resumeSubscription(providerSubscriptionId: string): Promise<void>;
  changeSubscriptionPrice(providerSubscriptionId: string, priceId: string): Promise<void>;
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionState>;
  refund(chargeRef: string, amountMinor: number | undefined, idempotencyKey: string): Promise<{ refundId: string; status: string }>;
}
