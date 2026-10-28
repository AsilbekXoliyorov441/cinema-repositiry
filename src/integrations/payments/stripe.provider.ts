import Stripe from 'stripe';
import type { BillingInterval } from '@prisma/client';
import { logger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import type {
  BillingEvent,
  BillingEventPayload,
  CheckoutRequest,
  CheckoutSession,
  PaymentProvider,
  ProviderPlan,
  ProviderSubscriptionState,
} from './payment-provider.types.js';

const INTERVAL: Record<BillingInterval, Stripe.PriceCreateParams.Recurring.Interval> = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
};

const idOf = (v: string | { id: string } | null | undefined): string | null => (v ? (typeof v === 'string' ? v : v.id) : null);
const fromUnix = (s: number | null | undefined): Date | null => (s ? new Date(s * 1000) : null);

function wrapProviderError(err: unknown): never {
  if (err instanceof AppError) throw err;
  const message = err instanceof Stripe.errors.StripeError ? err.message : 'Payment provider error';
  // Provider messages are safe to log but are not returned verbatim to clients.
  logger.error({ err: message, type: err instanceof Stripe.errors.StripeError ? err.type : undefined }, 'Stripe API call failed');
  throw AppError.payment('Payment provider request failed', ErrorCode.PAYMENT_PROVIDER_UNAVAILABLE, 502);
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'STRIPE' as const;
  readonly livemode: boolean;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.livemode = secretKey.startsWith('sk_live_');
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 15_000, appInfo: { name: 'CineWave' } });
  }

  async createCustomer(user: { id: string; email: string; name: string }): Promise<string> {
    try {
      const customer = await this.stripe.customers.create(
        { email: user.email, name: user.name, metadata: { userId: user.id } },
        { idempotencyKey: `customer:${user.id}:${this.livemode ? 'live' : 'test'}` },
      );
      return customer.id;
    } catch (err) {
      wrapProviderError(err);
    }
  }

  async createPrice(plan: ProviderPlan): Promise<string> {
    try {
      const price = await this.stripe.prices.create({
        currency: plan.currency.toLowerCase(),
        unit_amount: plan.priceMinor,
        recurring: { interval: INTERVAL[plan.billingInterval], interval_count: plan.intervalCount },
        product_data: { name: plan.name, metadata: { planId: plan.id } },
        metadata: { planId: plan.id },
      });
      return price.id;
    } catch (err) {
      wrapProviderError(err);
    }
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    try {
      let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
      if (req.discount && req.discount.amountMinor > 0) {
        const coupon = await this.stripe.coupons.create(
          { amount_off: req.discount.amountMinor, currency: req.discount.currency.toLowerCase(), duration: 'once', max_redemptions: 1 },
          { idempotencyKey: `coupon:${req.paymentId}` },
        );
        discounts = [{ coupon: coupon.id }];
      }
      const metadata = { subscriptionId: req.localSubscriptionId, paymentId: req.paymentId, userId: req.userId };
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: req.customerId,
          line_items: [{ price: req.priceId, quantity: 1 }],
          success_url: req.successUrl,
          cancel_url: req.cancelUrl,
          client_reference_id: req.localSubscriptionId,
          metadata,
          subscription_data: {
            metadata: { subscriptionId: req.localSubscriptionId, userId: req.userId },
            ...(req.trialDays > 0 ? { trial_period_days: req.trialDays } : {}),
          },
          discounts,
          expires_at: Math.floor(req.expiresAt.getTime() / 1000),
        },
        { idempotencyKey: `checkout:${req.idempotencyKey}` },
      );
      if (!session.url) throw AppError.payment('Provider did not return a checkout URL', ErrorCode.PAYMENT_PROVIDER_UNAVAILABLE, 502);
      return { checkoutId: session.id, url: session.url, expiresAt: fromUnix(session.expires_at) ?? req.expiresAt };
    } catch (err) {
      wrapProviderError(err);
    }
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<BillingEvent> {
    const signature = headers['stripe-signature'];
    if (typeof signature !== 'string') {
      throw AppError.payment('Missing Stripe-Signature header', ErrorCode.WEBHOOK_SIGNATURE_INVALID, 400);
    }
    let event: Stripe.Event;
    try {
      // Verifies HMAC signature and timestamp tolerance (default 5 minutes) — protects against forgery and replay.
      event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw AppError.payment('Invalid webhook signature', ErrorCode.WEBHOOK_SIGNATURE_INVALID, 400);
    }
    return { id: event.id, type: event.type, livemode: event.livemode, payload: await this.normalize(event) };
  }

  /** Resolves the PaymentIntent/Charge id of a paid invoice (used later for refunds). */
  async resolveChargeRef(invoiceId: string): Promise<string | null> {
    try {
      const payments = await this.stripe.invoicePayments.list({ invoice: invoiceId, limit: 1 });
      const p = payments.data[0]?.payment;
      return idOf(p?.payment_intent) ?? idOf(p?.charge);
    } catch (err) {
      logger.warn({ invoiceId, err: (err as Error).message }, 'Could not resolve invoice charge reference');
      return null;
    }
  }

  private async normalize(event: Stripe.Event): Promise<BillingEventPayload> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (s.mode !== 'subscription') return { kind: 'ignored' };
        return {
          kind: 'checkout.completed',
          checkoutId: s.id,
          providerSubscriptionId: idOf(s.subscription),
          localSubscriptionId: s.metadata?.subscriptionId ?? s.client_reference_id ?? null,
        };
      }
      case 'checkout.session.expired': {
        const s = event.data.object;
        return { kind: 'checkout.expired', checkoutId: s.id, localSubscriptionId: s.metadata?.subscriptionId ?? null };
      }
      case 'invoice.paid': {
        const inv = event.data.object;
        const details = inv.parent?.subscription_details;
        const providerSubscriptionId = idOf(details?.subscription);
        if (!providerSubscriptionId || !inv.id) return { kind: 'ignored' };
        const line = inv.lines.data[0];
        return {
          kind: 'invoice.paid',
          invoiceId: inv.id,
          providerSubscriptionId,
          localSubscriptionId: details?.metadata?.subscriptionId ?? null,
          amountPaidMinor: inv.amount_paid,
          currency: inv.currency.toUpperCase(),
          periodStart: fromUnix(line?.period.start) ?? new Date(),
          periodEnd: fromUnix(line?.period.end) ?? new Date(),
          chargeRef: inv.amount_paid > 0 ? await this.resolveChargeRef(inv.id) : null,
          isFirstInvoice: inv.billing_reason === 'subscription_create',
        };
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const details = inv.parent?.subscription_details;
        const providerSubscriptionId = idOf(details?.subscription);
        if (!providerSubscriptionId || !inv.id) return { kind: 'ignored' };
        return {
          kind: 'invoice.payment_failed',
          invoiceId: inv.id,
          providerSubscriptionId,
          localSubscriptionId: details?.metadata?.subscriptionId ?? null,
          amountDueMinor: inv.amount_due,
          currency: inv.currency.toUpperCase(),
          failureCode: inv.last_finalization_error?.code ?? null,
          isFirstInvoice: inv.billing_reason === 'subscription_create',
        };
      }
      case 'customer.subscription.updated':
        return { kind: 'subscription.updated', state: this.toState(event.data.object) };
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        return { kind: 'subscription.deleted', providerSubscriptionId: sub.id, endedAt: fromUnix(sub.ended_at) ?? new Date() };
      }
      case 'charge.refunded': {
        const charge = event.data.object;
        return {
          kind: 'charge.refunded',
          chargeRef: idOf(charge.payment_intent) ?? charge.id,
          amountMinor: charge.amount,
          amountRefundedMinor: charge.amount_refunded,
          currency: charge.currency.toUpperCase(),
        };
      }
      case 'charge.dispute.created': {
        const dispute = event.data.object;
        const ref = idOf(dispute.payment_intent) ?? idOf(dispute.charge);
        return ref ? { kind: 'charge.dispute_created', chargeRef: ref } : { kind: 'ignored' };
      }
      default:
        return { kind: 'ignored' };
    }
  }

  private toState(sub: Stripe.Subscription): ProviderSubscriptionState {
    const item = sub.items.data[0];
    return {
      providerSubscriptionId: sub.id,
      status: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodStart: fromUnix(item?.current_period_start),
      currentPeriodEnd: fromUnix(item?.current_period_end),
      priceId: item?.price.id ?? null,
      localSubscriptionId: sub.metadata?.subscriptionId ?? null,
    };
  }

  async cancelSubscription(providerSubscriptionId: string, options: { atPeriodEnd: boolean }): Promise<void> {
    try {
      if (options.atPeriodEnd) await this.stripe.subscriptions.update(providerSubscriptionId, { cancel_at_period_end: true });
      else await this.stripe.subscriptions.cancel(providerSubscriptionId);
    } catch (err) {
      wrapProviderError(err);
    }
  }

  async resumeSubscription(providerSubscriptionId: string): Promise<void> {
    try {
      await this.stripe.subscriptions.update(providerSubscriptionId, { cancel_at_period_end: false });
    } catch (err) {
      wrapProviderError(err);
    }
  }

  async changeSubscriptionPrice(providerSubscriptionId: string, priceId: string): Promise<void> {
    try {
      const sub = await this.stripe.subscriptions.retrieve(providerSubscriptionId);
      const item = sub.items.data[0];
      if (!item) throw AppError.conflict('Provider subscription has no items');
      await this.stripe.subscriptions.update(providerSubscriptionId, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: 'create_prorations',
      });
    } catch (err) {
      wrapProviderError(err);
    }
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionState> {
    try {
      return this.toState(await this.stripe.subscriptions.retrieve(providerSubscriptionId));
    } catch (err) {
      wrapProviderError(err);
    }
  }

  async refund(chargeRef: string, amountMinor: number | undefined, idempotencyKey: string) {
    try {
      const refund = await this.stripe.refunds.create(
        {
          ...(chargeRef.startsWith('pi_') ? { payment_intent: chargeRef } : { charge: chargeRef }),
          ...(amountMinor ? { amount: amountMinor } : {}),
          reason: 'requested_by_customer',
        },
        { idempotencyKey },
      );
      return { refundId: refund.id, status: refund.status ?? 'pending' };
    } catch (err) {
      wrapProviderError(err);
    }
  }
}
