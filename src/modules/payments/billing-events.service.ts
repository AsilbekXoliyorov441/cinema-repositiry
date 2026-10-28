import type { PaymentProviderName, Subscription } from '@prisma/client';
import { prisma, type Tx } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { formatMoney } from '../../common/utils/money.js';
import type { BillingEvent, BillingEventPayload, ProviderSubscriptionState } from '../../integrations/payments/payment-provider.types.js';
import { enqueueEmail } from '../../jobs/queues.js';
import { couponsService } from '../coupons/coupons.service.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { canTransitionPayment, canTransitionSubscription } from '../subscriptions/subscription-state.js';

type SideEffect = () => Promise<void>;
type ProcessResult = 'processed' | 'duplicate' | 'ignored';

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

async function findSubscription(tx: Tx, providerSubscriptionId: string, localId: string | null): Promise<Subscription | null> {
  const byProvider = await tx.subscription.findUnique({ where: { providerSubscriptionId } });
  if (byProvider) return byProvider;
  if (!localId) return null;
  const byLocal = await tx.subscription.findUnique({ where: { id: localId } });
  // Link the provider id on first sight (invoice.paid can arrive before checkout.session.completed).
  if (byLocal && !byLocal.providerSubscriptionId) {
    return tx.subscription.update({ where: { id: byLocal.id }, data: { providerSubscriptionId } });
  }
  return byLocal?.providerSubscriptionId === providerSubscriptionId ? byLocal : null;
}

async function userContact(tx: Tx, userId: string) {
  return tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, displayName: true } });
}

/**
 * Applies a verified, normalized provider event to the database. Runs inside the transaction that
 * also marks the webhook event PROCESSED — the change and its idempotency record commit together.
 */
async function apply(tx: Tx, provider: PaymentProviderName, livemode: boolean, p: BillingEventPayload, effects: SideEffect[]): Promise<void> {
  switch (p.kind) {
    case 'ignored':
      return;

    case 'checkout.completed': {
      if (!p.providerSubscriptionId) return;
      const sub = p.localSubscriptionId
        ? await tx.subscription.findUnique({ where: { id: p.localSubscriptionId } })
        : await tx.subscription.findUnique({ where: { providerCheckoutId: p.checkoutId } });
      if (sub && !sub.providerSubscriptionId) {
        await tx.subscription.update({ where: { id: sub.id }, data: { providerSubscriptionId: p.providerSubscriptionId } });
      }
      // Activation happens only on invoice.paid (money actually collected).
      return;
    }

    case 'checkout.expired': {
      const sub = await tx.subscription.findUnique({ where: { providerCheckoutId: p.checkoutId } });
      if (!sub || sub.status !== 'PENDING') return;
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED', endedAt: new Date(), statusReason: 'Checkout expired' } });
      await tx.payment.updateMany({ where: { subscriptionId: sub.id, status: 'PENDING' }, data: { status: 'CANCELED' } });
      await couponsService.release(tx, { subscriptionId: sub.id });
      return;
    }

    case 'invoice.paid': {
      const sub = await findSubscription(tx, p.providerSubscriptionId, p.localSubscriptionId);
      if (!sub) {
        logger.warn({ providerSubscriptionId: p.providerSubscriptionId }, 'invoice.paid for unknown subscription');
        return;
      }
      if (!canTransitionSubscription(sub.status, 'ACTIVE')) {
        logger.warn({ subscriptionId: sub.id, status: sub.status }, 'invoice.paid for a terminal subscription — not reactivated');
        return;
      }

      // Payment record: idempotent by provider invoice id.
      const existing = await tx.payment.findUnique({ where: { providerPaymentId: p.invoiceId } });
      let paymentId: string;
      if (existing) {
        paymentId = existing.id;
        if (existing.status !== 'SUCCEEDED' && canTransitionPayment(existing.status, 'SUCCEEDED')) {
          await tx.payment.update({ where: { id: existing.id }, data: { status: 'SUCCEEDED', paidAt: new Date(), amountMinor: p.amountPaidMinor, providerChargeRef: p.chargeRef } });
        }
      } else {
        const initial = p.isFirstInvoice
          ? await tx.payment.findFirst({ where: { subscriptionId: sub.id, status: 'PENDING', providerPaymentId: null }, orderBy: { createdAt: 'asc' } })
          : null;
        if (initial) {
          if (initial.amountMinor !== p.amountPaidMinor) {
            logger.warn({ paymentId: initial.id, expected: initial.amountMinor, paid: p.amountPaidMinor }, 'Paid amount differs from expected (trial/proration?) — provider amount recorded');
          }
          await tx.payment.update({
            where: { id: initial.id },
            data: { status: 'SUCCEEDED', providerPaymentId: p.invoiceId, providerChargeRef: p.chargeRef, amountMinor: p.amountPaidMinor, currency: p.currency, paidAt: new Date() },
          });
          paymentId = initial.id;
        } else {
          const created = await tx.payment.create({
            data: {
              userId: sub.userId,
              subscriptionId: sub.id,
              provider,
              providerPaymentId: p.invoiceId,
              providerChargeRef: p.chargeRef,
              idempotencyKey: `${provider.toLowerCase()}:invoice:${p.invoiceId}`,
              amountMinor: p.amountPaidMinor,
              currency: p.currency,
              status: 'SUCCEEDED',
              livemode,
              paidAt: new Date(),
              metadata: { kind: p.isFirstInvoice ? 'initial' : 'renewal' },
            },
          });
          paymentId = created.id;
        }
      }
      await couponsService.markRedeemed(tx, paymentId);

      const wasActive = sub.status === 'ACTIVE';
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'ACTIVE',
          startsAt: sub.startsAt ?? p.periodStart,
          currentPeriodStart: p.periodStart,
          currentPeriodEnd: p.periodEnd,
          expiryReminderSentAt: null,
          statusReason: null,
        },
        include: { plan: true },
      });
      const contact = await userContact(tx, sub.userId);
      const amount = formatMoney(p.amountPaidMinor, p.currency);
      await notificationsService.notify(
        wasActive
          ? { userId: sub.userId, type: 'PAYMENT_SUCCEEDED', title: 'Payment received', body: `${amount} — ${updated.plan.name} renewed until ${day(p.periodEnd)}.` }
          : { userId: sub.userId, type: 'SUBSCRIPTION_ACTIVATED', title: `${updated.plan.name} is active`, body: `Enjoy Pro until ${day(p.periodEnd)}.` },
        tx,
      );
      effects.push(async () => {
        if (!wasActive) {
          await enqueueEmail({ to: contact.email, template: 'subscription-activated', data: { name: contact.displayName, planName: updated.plan.name, periodEnd: day(p.periodEnd) } });
        }
        if (p.amountPaidMinor > 0) {
          await enqueueEmail({ to: contact.email, template: 'payment-succeeded', data: { name: contact.displayName, amount, planName: updated.plan.name } });
        }
      });
      return;
    }

    case 'invoice.payment_failed': {
      const sub = await findSubscription(tx, p.providerSubscriptionId, p.localSubscriptionId);
      if (!sub) return;
      const existing = await tx.payment.findUnique({ where: { providerPaymentId: p.invoiceId } });
      if (existing) {
        if (canTransitionPayment(existing.status, 'FAILED')) {
          await tx.payment.update({ where: { id: existing.id }, data: { status: 'FAILED', failedAt: new Date(), failureCode: p.failureCode } });
        }
      } else {
        const initial = p.isFirstInvoice
          ? await tx.payment.findFirst({ where: { subscriptionId: sub.id, status: 'PENDING', providerPaymentId: null } })
          : null;
        if (initial) {
          await tx.payment.update({ where: { id: initial.id }, data: { status: 'FAILED', providerPaymentId: p.invoiceId, failedAt: new Date(), failureCode: p.failureCode } });
        } else {
          await tx.payment.create({
            data: {
              userId: sub.userId,
              subscriptionId: sub.id,
              provider,
              providerPaymentId: p.invoiceId,
              idempotencyKey: `${provider.toLowerCase()}:invoice:${p.invoiceId}`,
              amountMinor: p.amountDueMinor,
              currency: p.currency,
              status: 'FAILED',
              livemode,
              failedAt: new Date(),
              failureCode: p.failureCode,
              metadata: { kind: 'renewal' },
            },
          });
        }
      }
      // A failed payment never grants access: renewals go PAST_DUE, first payments stay PENDING.
      if (sub.status === 'ACTIVE') {
        await tx.subscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE', statusReason: 'Renewal payment failed' } });
      }
      const plan = await tx.subscriptionPlan.findUniqueOrThrow({ where: { id: sub.planId } });
      const contact = await userContact(tx, sub.userId);
      const amount = formatMoney(p.amountDueMinor, p.currency);
      await notificationsService.notify({ userId: sub.userId, type: 'PAYMENT_FAILED', title: 'Payment failed', body: `We could not charge ${amount} for ${plan.name}.` }, tx);
      effects.push(() => enqueueEmail({ to: contact.email, template: 'payment-failed', data: { name: contact.displayName, amount, planName: plan.name } }));
      return;
    }

    case 'subscription.updated':
      await syncSubscriptionState(tx, p.state);
      return;

    case 'subscription.deleted': {
      const sub = await tx.subscription.findUnique({ where: { providerSubscriptionId: p.providerSubscriptionId } });
      if (!sub || !canTransitionSubscription(sub.status, 'CANCELED')) return;
      await tx.subscription.update({
        where: { id: sub.id },
        data: { status: 'CANCELED', endedAt: p.endedAt, canceledAt: sub.canceledAt ?? p.endedAt, cancelAtPeriodEnd: false },
      });
      await couponsService.release(tx, { subscriptionId: sub.id });
      return;
    }

    case 'charge.refunded': {
      const payment = await tx.payment.findFirst({ where: { providerChargeRef: p.chargeRef } });
      if (!payment) {
        logger.warn({ chargeRef: p.chargeRef }, 'Refund for unknown payment');
        return;
      }
      const refunded = Math.min(p.amountRefundedMinor, payment.amountMinor);
      const full = refunded >= payment.amountMinor;
      const status = full ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      if (!canTransitionPayment(payment.status, status) && payment.status !== status) return;
      await tx.payment.update({ where: { id: payment.id }, data: { status, refundedMinor: refunded, refundedAt: new Date() } });

      // Full refund of the payment funding the current period revokes premium access.
      if (full && payment.subscriptionId) {
        const sub = await tx.subscription.findUnique({ where: { id: payment.subscriptionId } });
        const latest = await tx.payment.findFirst({ where: { subscriptionId: payment.subscriptionId, status: { in: ['SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED'] } }, orderBy: { paidAt: 'desc' } });
        if (sub && latest?.id === payment.id && canTransitionSubscription(sub.status, 'SUSPENDED') && sub.status !== 'SUSPENDED') {
          await tx.subscription.update({ where: { id: sub.id }, data: { status: 'SUSPENDED', statusReason: 'Payment refunded' } });
        }
      }
      await notificationsService.notify(
        { userId: payment.userId, type: 'PAYMENT_REFUNDED', title: 'Refund issued', body: `${formatMoney(refunded, payment.currency)} has been refunded.` },
        tx,
      );
      return;
    }

    case 'charge.dispute_created': {
      const payment = await tx.payment.findFirst({ where: { providerChargeRef: p.chargeRef } });
      if (!payment?.subscriptionId) return;
      const sub = await tx.subscription.findUnique({ where: { id: payment.subscriptionId } });
      if (sub && sub.status !== 'SUSPENDED' && canTransitionSubscription(sub.status, 'SUSPENDED')) {
        await tx.subscription.update({ where: { id: sub.id }, data: { status: 'SUSPENDED', statusReason: 'Payment disputed (chargeback)' } });
      }
      return;
    }
  }
}

/** Mirrors provider subscription state (cancel flag, plan change, terminal statuses). Never activates. */
export async function syncSubscriptionState(tx: Tx, state: ProviderSubscriptionState): Promise<void> {
  const sub = await tx.subscription.findUnique({ where: { providerSubscriptionId: state.providerSubscriptionId } });
  if (!sub) return;

  let planId: string | undefined;
  if (state.priceId) {
    const price = await tx.planProviderPrice.findFirst({ where: { providerPriceId: state.priceId } });
    if (price && price.planId !== sub.planId) planId = price.planId;
  }

  let status = sub.status;
  if ((state.status === 'past_due' || state.status === 'unpaid') && sub.status === 'ACTIVE') status = 'PAST_DUE';
  if (state.status === 'canceled' && canTransitionSubscription(sub.status, 'CANCELED')) status = 'CANCELED';
  if (state.status === 'incomplete_expired' && canTransitionSubscription(sub.status, 'EXPIRED')) status = 'EXPIRED';

  await tx.subscription.update({
    where: { id: sub.id },
    data: {
      status,
      planId,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      canceledAt: state.cancelAtPeriodEnd ? (sub.canceledAt ?? new Date()) : status === 'CANCELED' ? new Date() : null,
      ...(status === 'CANCELED' || status === 'EXPIRED' ? { endedAt: new Date() } : {}),
      // Period dates are trusted only while the subscription is in good standing (set by invoice.paid otherwise).
      ...(sub.status === 'ACTIVE' && state.currentPeriodEnd && state.currentPeriodEnd > (sub.currentPeriodEnd ?? new Date(0)) && state.status === 'active'
        ? { currentPeriodStart: state.currentPeriodStart, currentPeriodEnd: state.currentPeriodEnd }
        : {}),
    },
  });
}

export const billingEventsService = {
  /**
   * Idempotent webhook processing:
   *  1. The event id is inserted once (unique provider+eventId); the row is locked FOR UPDATE.
   *  2. Already PROCESSED/IGNORED → duplicate, nothing happens.
   *  3. Domain changes + PROCESSED mark commit atomically; on error everything rolls back,
   *     the event is marked FAILED and the provider retries later.
   */
  async process(provider: PaymentProviderName, event: BillingEvent): Promise<ProcessResult> {
    const effects: SideEffect[] = [];
    const expectedLive = env.PAYMENT_MODE === 'live';

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            INSERT INTO payment_webhook_events (id, provider, "eventId", "eventType", livemode, status, attempts, "createdAt")
            VALUES (gen_random_uuid(), ${provider}::"PaymentProviderName", ${event.id}, ${event.type}, ${event.livemode}, 'RECEIVED', 0, now())
            ON CONFLICT (provider, "eventId") DO NOTHING`;
          const [row] = await tx.$queryRaw<{ id: string; status: string }[]>`
            SELECT id, status::text FROM payment_webhook_events
            WHERE provider = ${provider}::"PaymentProviderName" AND "eventId" = ${event.id} FOR UPDATE`;
          if (!row) throw new Error('Webhook event row missing');
          if (row.status === 'PROCESSED' || row.status === 'IGNORED') return 'duplicate' as const;

          // Test-mode events never touch a live deployment and vice versa.
          const ignore = event.livemode !== expectedLive || event.payload.kind === 'ignored';
          if (!ignore) await apply(tx, provider, event.livemode, event.payload, effects);

          await tx.paymentWebhookEvent.update({
            where: { id: row.id },
            data: { status: ignore ? 'IGNORED' : 'PROCESSED', processedAt: new Date(), attempts: { increment: 1 }, error: null },
          });
          return ignore ? ('ignored' as const) : ('processed' as const);
        },
        { isolationLevel: 'ReadCommitted', timeout: 20_000 },
      );

      for (const effect of effects) await effect().catch((err: Error) => logger.error({ err: err.message }, 'Webhook side effect failed'));
      return result;
    } catch (err) {
      // The transaction rolled back (including the RECEIVED row), so record the failure separately.
      const error = (err as Error).message.slice(0, 1000);
      await prisma.paymentWebhookEvent
        .upsert({
          where: { provider_eventId: { provider, eventId: event.id } },
          create: { provider, eventId: event.id, eventType: event.type, livemode: event.livemode, status: 'FAILED', attempts: 1, error },
          update: { status: 'FAILED', attempts: { increment: 1 }, error },
        })
        .catch(() => undefined);
      throw err;
    }
  },
};
