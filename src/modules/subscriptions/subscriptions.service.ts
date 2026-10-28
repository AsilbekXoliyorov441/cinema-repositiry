import { randomUUID } from 'node:crypto';
import type { Prisma, Subscription, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import { prisma, type Tx } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthContext } from '../../common/types/auth.js';
import { addDays, addMs } from '../../common/utils/duration.js';
import { buildMeta, toSkipTake, type PaginationInput } from '../../common/utils/pagination.js';
import { getPaymentProvider } from '../../integrations/payments/index.js';
import type { PaymentProvider } from '../../integrations/payments/payment-provider.types.js';
import { enqueueEmail } from '../../jobs/queues.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { couponsService } from '../coupons/coupons.service.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { plansService, toPlanView } from '../plans/plans.service.js';
import { settingsService } from '../settings/settings.service.js';
import { entitlementService } from './entitlement.service.js';
import { assertSubscriptionTransition, OPEN_SUBSCRIPTION_STATUSES } from './subscription-state.js';

type Client = { ip?: string | undefined; userAgent?: string | undefined };
type SubWithPlan = Subscription & { plan: SubscriptionPlan };

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

export function toSubscriptionView(s: SubWithPlan) {
  return {
    id: s.id,
    status: s.status,
    plan: toPlanView(s.plan),
    provider: s.provider,
    startsAt: s.startsAt?.toISOString() ?? null,
    currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
    trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    canceledAt: s.canceledAt?.toISOString() ?? null,
    endedAt: s.endedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Transitions a subscription after validating the state machine; returns the update payload. */
export async function transition(tx: Tx, sub: Subscription, to: SubscriptionStatus, data: Prisma.SubscriptionUncheckedUpdateInput = {}) {
  assertSubscriptionTransition(sub.status, to);
  return tx.subscription.update({ where: { id: sub.id }, data: { ...data, status: to }, include: { plan: true } });
}

async function ensureCustomer(provider: PaymentProvider, user: { id: string; email: string; displayName: string }): Promise<string> {
  const existing = await prisma.billingCustomer.findUnique({
    where: { userId_provider_livemode: { userId: user.id, provider: provider.name, livemode: provider.livemode } },
  });
  if (existing) return existing.providerCustomerId;
  const customerId = await provider.createCustomer({ id: user.id, email: user.email, name: user.displayName });
  await prisma.billingCustomer
    .create({ data: { userId: user.id, provider: provider.name, livemode: provider.livemode, providerCustomerId: customerId } })
    .catch(() => undefined); // concurrent creation: the provider call was idempotent, the row already exists
  return customerId;
}

async function ensurePrice(provider: PaymentProvider, plan: SubscriptionPlan): Promise<string> {
  const key = {
    planId: plan.id,
    provider: provider.name,
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    billingInterval: plan.billingInterval,
    intervalCount: plan.intervalCount,
    livemode: provider.livemode,
  };
  const existing = await prisma.planProviderPrice.findFirst({ where: key });
  if (existing) return existing.providerPriceId;
  const providerPriceId = await provider.createPrice(plan);
  try {
    await prisma.planProviderPrice.create({ data: { ...key, providerPriceId } });
    return providerPriceId;
  } catch {
    // Lost a race with a concurrent checkout: use the stored price.
    return (await prisma.planProviderPrice.findFirstOrThrow({ where: key })).providerPriceId;
  }
}

export const subscriptionsService = {
  async current(userId: string) {
    const [sub, entitlement] = await Promise.all([
      prisma.subscription.findFirst({
        where: { userId, status: { in: OPEN_SUBSCRIPTION_STATUSES } },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      }),
      entitlementService.forUser(userId),
    ]);
    return {
      subscription: sub ? toSubscriptionView(sub) : null,
      entitlement: { isPro: entitlement.isPro, features: entitlement.features, reason: entitlement.reason, validUntil: entitlement.validUntil?.toISOString() ?? null },
    };
  },

  async history(userId: string, query: PaginationInput) {
    const where = { userId };
    const [rows, total] = await prisma.$transaction([
      prisma.subscription.findMany({ where, include: { plan: true }, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
      prisma.subscription.count({ where }),
    ]);
    return { items: rows.map(toSubscriptionView), meta: buildMeta(query, total) };
  },

  /**
   * Starts a hosted checkout. The price is read from the database; the subscription stays PENDING
   * and is activated exclusively by a verified provider webhook — never by the redirect back.
   */
  async startCheckout(auth: AuthContext, input: { planId: string; couponCode?: string | undefined }, idempotencyKeyHeader: string | undefined, client: Client) {
    const provider = getPaymentProvider();
    const idempotencyKey = idempotencyKeyHeader ?? randomUUID();

    // Retried request with the same Idempotency-Key → same checkout session.
    const replay = await prisma.payment.findUnique({ where: { idempotencyKey } });
    if (replay) {
      if (replay.userId !== auth.userId) throw AppError.conflict('Idempotency-Key already used');
      const meta = (replay.metadata ?? {}) as { checkoutUrl?: string; checkoutExpiresAt?: string };
      if (replay.status === 'PENDING' && meta.checkoutUrl) {
        return { checkoutUrl: meta.checkoutUrl, subscriptionId: replay.subscriptionId, paymentId: replay.id, expiresAt: meta.checkoutExpiresAt ?? null };
      }
      throw AppError.conflict('This checkout was already completed or canceled; start a new one');
    }

    const plan = await plansService.getPurchasable(input.planId);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, email: true, displayName: true } });

    const open = await prisma.subscription.findFirst({ where: { userId: auth.userId, status: { in: OPEN_SUBSCRIPTION_STATUSES } } });
    if (open && open.status !== 'PENDING') {
      throw AppError.conflict('You already have a subscription. Use change-plan to switch plans.');
    }

    const customerId = await ensureCustomer(provider, user);
    const priceId = await ensurePrice(provider, plan);
    const expiresAt = addMs(new Date(), env.CHECKOUT_RESERVATION_MINUTES * 60_000);

    const { subscription, payment, discountMinor } = await prisma.$transaction(async (tx) => {
      if (open) {
        // Replace an abandoned pending checkout.
        await transition(tx, open, 'EXPIRED', { endedAt: new Date(), statusReason: 'Replaced by a new checkout' });
        await tx.payment.updateMany({ where: { subscriptionId: open.id, status: 'PENDING' }, data: { status: 'CANCELED' } });
        await couponsService.release(tx, { subscriptionId: open.id });
      }
      const sub = await tx.subscription.create({
        data: { userId: auth.userId, planId: plan.id, status: 'PENDING', provider: provider.name, livemode: provider.livemode },
      });
      const pay = await tx.payment.create({
        data: {
          userId: auth.userId,
          subscriptionId: sub.id,
          provider: provider.name,
          idempotencyKey,
          amountMinor: plan.priceMinor,
          currency: plan.currency,
          livemode: provider.livemode,
          metadata: { planSlug: plan.slug, kind: 'initial' },
        },
      });
      let discount = 0;
      if (input.couponCode) {
        const result = await couponsService.reserve(tx, { code: input.couponCode, plan, userId: auth.userId, subscriptionId: sub.id, paymentId: pay.id, expiresAt });
        discount = result.discountMinor;
        await tx.payment.update({ where: { id: pay.id }, data: { discountMinor: discount, amountMinor: result.finalMinor } });
      }
      return { subscription: sub, payment: pay, discountMinor: discount };
    });

    const front = env.FRONTEND_URL.replace(/\/$/, '');
    let session;
    try {
      session = await provider.createCheckout({
        customerId,
        priceId,
        localSubscriptionId: subscription.id,
        paymentId: payment.id,
        userId: auth.userId,
        idempotencyKey,
        discount: discountMinor > 0 ? { amountMinor: discountMinor, currency: plan.currency } : null,
        trialDays: plan.trialDays,
        successUrl: `${front}${env.CHECKOUT_SUCCESS_PATH}?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${front}${env.CHECKOUT_CANCEL_PATH}`,
        expiresAt,
      });
    } catch (err) {
      await prisma.$transaction(async (tx) => {
        await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'EXPIRED', endedAt: new Date(), statusReason: 'Checkout creation failed' } });
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'CANCELED' } });
        await couponsService.release(tx, { paymentId: payment.id });
      });
      throw err;
    }

    await prisma.$transaction([
      prisma.subscription.update({ where: { id: subscription.id }, data: { providerCheckoutId: session.checkoutId } }),
      prisma.payment.update({
        where: { id: payment.id },
        data: { metadata: { planSlug: plan.slug, kind: 'initial', checkoutUrl: session.url, checkoutExpiresAt: session.expiresAt.toISOString(), couponCode: input.couponCode ?? null } },
      }),
    ]);
    await writeAudit({ actorId: auth.userId, action: 'checkout.start', entityType: 'subscription', entityId: subscription.id, metadata: { planId: plan.id }, client });
    return { checkoutUrl: session.url, subscriptionId: subscription.id, paymentId: payment.id, expiresAt: session.expiresAt.toISOString() };
  },

  async cancel(auth: AuthContext, options: { atPeriodEnd: boolean }, client: Client) {
    const sub = await prisma.subscription.findFirst({
      where: { userId: auth.userId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
      include: { plan: true, user: { select: { email: true, displayName: true } } },
    });
    if (!sub) throw AppError.notFound('Active subscription');
    if (options.atPeriodEnd && sub.cancelAtPeriodEnd) throw AppError.conflict('Subscription is already set to cancel');

    if (sub.provider !== 'MANUAL' && sub.providerSubscriptionId) {
      await getPaymentProvider().cancelSubscription(sub.providerSubscriptionId, options);
    }
    const updated = await prisma.$transaction(async (tx) => {
      const result = options.atPeriodEnd
        ? await tx.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true, canceledAt: new Date() }, include: { plan: true } })
        : await transition(tx, sub, 'CANCELED', { canceledAt: new Date(), endedAt: new Date(), cancelAtPeriodEnd: false });
      await writeAudit({ actorId: auth.userId, action: 'subscription.cancel', entityType: 'subscription', entityId: sub.id, metadata: options, client }, tx);
      return result;
    });
    const accessUntil = options.atPeriodEnd ? day(sub.currentPeriodEnd) : null;
    await enqueueEmail({ to: sub.user.email, template: 'subscription-canceled', data: { name: sub.user.displayName, planName: sub.plan.name, accessUntil } });
    await notificationsService.notify({
      userId: auth.userId,
      type: 'SUBSCRIPTION_CANCELED',
      title: 'Subscription canceled',
      body: accessUntil ? `You keep Pro access until ${accessUntil}.` : 'Your subscription has ended.',
    });
    return toSubscriptionView(updated);
  },

  async resume(auth: AuthContext, client: Client) {
    const sub = await prisma.subscription.findFirst({ where: { userId: auth.userId, status: 'ACTIVE', cancelAtPeriodEnd: true }, include: { plan: true } });
    if (!sub) throw AppError.notFound('Subscription scheduled for cancellation');
    if (sub.currentPeriodEnd && sub.currentPeriodEnd <= new Date()) throw AppError.conflict('The billing period already ended');
    if (sub.provider !== 'MANUAL' && sub.providerSubscriptionId) await getPaymentProvider().resumeSubscription(sub.providerSubscriptionId);
    const updated = await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false, canceledAt: null }, include: { plan: true } });
    await writeAudit({ actorId: auth.userId, action: 'subscription.resume', entityType: 'subscription', entityId: sub.id, client });
    return toSubscriptionView(updated);
  },

  /** Requests a plan change at the provider (with proration). The local plan switches when the provider confirms via webhook. */
  async changePlan(auth: AuthContext, planId: string, client: Client) {
    const sub = await prisma.subscription.findFirst({ where: { userId: auth.userId, status: 'ACTIVE' }, include: { plan: true } });
    if (!sub) throw AppError.notFound('Active subscription');
    if (sub.planId === planId) throw AppError.conflict('You are already on this plan');
    if (sub.provider === 'MANUAL' || !sub.providerSubscriptionId) throw AppError.conflict('This subscription is managed by support and cannot be changed online');
    const plan = await plansService.getPurchasable(planId);
    if (plan.currency !== sub.plan.currency) throw AppError.conflict('Switching to a plan in a different currency is not supported');
    const provider = getPaymentProvider();
    const priceId = await ensurePrice(provider, plan);
    await provider.changeSubscriptionPrice(sub.providerSubscriptionId, priceId);
    await writeAudit({ actorId: auth.userId, action: 'subscription.change_plan_requested', entityType: 'subscription', entityId: sub.id, metadata: { from: sub.planId, to: planId }, client });
    return { status: 'PENDING_CONFIRMATION' as const, requestedPlan: toPlanView(plan), subscription: toSubscriptionView(sub) };
  },

  // ───── Admin ─────

  async adminList(query: PaginationInput & { status?: SubscriptionStatus | undefined; userId?: string | undefined }) {
    const where: Prisma.SubscriptionWhereInput = { ...(query.status ? { status: query.status } : {}), ...(query.userId ? { userId: query.userId } : {}) };
    const [rows, total] = await prisma.$transaction([
      prisma.subscription.findMany({
        where,
        include: { plan: true, user: { select: { id: true, email: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(query),
      }),
      prisma.subscription.count({ where }),
    ]);
    return { items: rows.map((s) => ({ ...toSubscriptionView(s), user: s.user, statusReason: s.statusReason })), meta: buildMeta(query, total) };
  },

  async adminGet(id: string) {
    const s = await prisma.subscription.findUnique({
      where: { id },
      include: { plan: true, user: { select: { id: true, email: true, displayName: true } }, payments: { orderBy: { createdAt: 'desc' } } },
    });
    if (!s) throw AppError.notFound('Subscription');
    return {
      ...toSubscriptionView(s),
      user: s.user,
      statusReason: s.statusReason,
      providerSubscriptionId: s.providerSubscriptionId,
      payments: s.payments.map((p) => ({ id: p.id, status: p.status, amountMinor: p.amountMinor, refundedMinor: p.refundedMinor, currency: p.currency, paidAt: p.paidAt?.toISOString() ?? null })),
    };
  },

  /** Manual grant (support, promotions). Creates a MANUAL subscription without any payment. */
  async grant(actor: AuthContext, input: { userId: string; planId: string; days: number; reason: string }, client: Client) {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: input.planId } });
    if (!plan) throw AppError.notFound('Plan');
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, status: true } });
    if (!user || user.status === 'DELETED') throw AppError.notFound('User');
    const now = new Date();
    const sub = await prisma.$transaction(async (tx) => {
      const created = await tx.subscription.create({
        data: {
          userId: input.userId,
          planId: plan.id,
          status: 'ACTIVE',
          provider: 'MANUAL',
          startsAt: now,
          currentPeriodStart: now,
          currentPeriodEnd: addDays(now, input.days),
          statusReason: input.reason,
        },
        include: { plan: true },
      });
      await writeAudit(
        { actorId: actor.userId, action: 'subscription.grant', entityType: 'subscription', entityId: created.id, severity: 'HIGH', metadata: input, client },
        tx,
      );
      return created;
    });
    await notificationsService.notify({ userId: input.userId, type: 'SUBSCRIPTION_ACTIVATED', title: `${plan.name} activated`, body: `Access granted until ${day(sub.currentPeriodEnd)}.` });
    return toSubscriptionView(sub);
  },

  async extend(actor: AuthContext, id: string, input: { days: number; reason: string }, client: Client) {
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw AppError.notFound('Subscription');
    if (sub.provider !== 'MANUAL') throw AppError.conflict('Provider-billed subscriptions are extended at the provider (e.g. a trial extension in Stripe)');
    if (!['ACTIVE', 'SUSPENDED'].includes(sub.status)) throw AppError.conflict('Only active or suspended subscriptions can be extended');
    const base = sub.currentPeriodEnd && sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.subscription.update({ where: { id }, data: { currentPeriodEnd: addDays(base, input.days) }, include: { plan: true } });
      await writeAudit({ actorId: actor.userId, action: 'subscription.extend', entityType: 'subscription', entityId: id, severity: 'HIGH', metadata: input, client }, tx);
      return r;
    });
    return toSubscriptionView(updated);
  },

  async adminSetStatus(actor: AuthContext, id: string, to: 'SUSPENDED' | 'ACTIVE' | 'CANCELED', reason: string, client: Client) {
    const sub = await prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw AppError.notFound('Subscription');
    if (to === 'ACTIVE' && sub.status !== 'SUSPENDED') throw AppError.conflict('Only suspended subscriptions can be reinstated');
    if (to === 'CANCELED' && sub.provider !== 'MANUAL' && sub.providerSubscriptionId) {
      await getPaymentProvider().cancelSubscription(sub.providerSubscriptionId, { atPeriodEnd: false });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const r = await transition(tx, sub, to, {
        statusReason: reason,
        ...(to === 'CANCELED' ? { canceledAt: new Date(), endedAt: new Date() } : {}),
      });
      await writeAudit({ actorId: actor.userId, action: `subscription.${to.toLowerCase()}`, entityType: 'subscription', entityId: id, severity: 'HIGH', metadata: { reason }, client }, tx);
      return r;
    });
    return toSubscriptionView(updated);
  },

  // ───── Jobs ─────

  /**
   * Marks subscriptions whose period ended as EXPIRED. Idempotent. Provider-billed subscriptions get a
   * grace window for late renewal webhooks (entitlement already denies access exactly at period end).
   * Abandoned PENDING checkouts are expired too.
   */
  async expireDue(now = new Date()) {
    const providerGrace = addDays(now, -3);
    const due = await prisma.subscription.findMany({
      where: {
        OR: [
          { status: { in: ['ACTIVE', 'PAST_DUE', 'SUSPENDED'] }, provider: 'MANUAL', currentPeriodEnd: { lt: now } },
          { status: { in: ['ACTIVE', 'PAST_DUE', 'SUSPENDED'] }, provider: { not: 'MANUAL' }, currentPeriodEnd: { lt: providerGrace } },
          { status: 'PENDING', createdAt: { lt: addMs(now, -env.CHECKOUT_RESERVATION_MINUTES * 60_000 - 3_600_000) } },
        ],
      },
      include: { plan: true },
      take: 500,
    });
    let expired = 0;
    for (const sub of due) {
      await prisma.$transaction(async (tx) => {
        // Re-read under lock-free conditional update so concurrent job runs do not double-process.
        const r = await tx.subscription.updateMany({ where: { id: sub.id, status: sub.status }, data: { status: 'EXPIRED', endedAt: now } });
        if (r.count === 0) return;
        await tx.payment.updateMany({ where: { subscriptionId: sub.id, status: 'PENDING' }, data: { status: 'CANCELED' } });
        await couponsService.release(tx, { subscriptionId: sub.id });
        if (sub.status !== 'PENDING') {
          await notificationsService.notify(
            { userId: sub.userId, type: 'SUBSCRIPTION_EXPIRED', title: 'Subscription expired', body: `Your ${sub.plan.name} subscription has ended.` },
            tx,
          );
        }
        expired++;
      });
    }
    if (expired) logger.info({ expired }, 'Expired subscriptions');
    return expired;
  },

  /** Sends one reminder per period N days before the end for subscriptions that will not renew. */
  async sendExpiryReminders(now = new Date()) {
    const days = await settingsService.get('subscriptions.expiryReminderDays');
    const subs = await prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        currentPeriodEnd: { gt: now, lte: addDays(now, days) },
        OR: [{ cancelAtPeriodEnd: true }, { provider: 'MANUAL' }],
        expiryReminderSentAt: null,
      },
      include: { plan: true, user: { select: { email: true, displayName: true } } },
      take: 500,
    });
    for (const s of subs) {
      const claimed = await prisma.subscription.updateMany({ where: { id: s.id, expiryReminderSentAt: null }, data: { expiryReminderSentAt: now } });
      if (claimed.count === 0) continue;
      await enqueueEmail({ to: s.user.email, template: 'subscription-expiring', data: { name: s.user.displayName, planName: s.plan.name, periodEnd: day(s.currentPeriodEnd) } });
      await notificationsService.notify({ userId: s.userId, type: 'SUBSCRIPTION_EXPIRING', title: 'Subscription ending soon', body: `Your ${s.plan.name} access ends on ${day(s.currentPeriodEnd)}.` });
    }
    return subs.length;
  },
};
