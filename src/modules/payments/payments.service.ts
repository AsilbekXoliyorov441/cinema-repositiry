import type { PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthContext } from '../../common/types/auth.js';
import { formatMoney } from '../../common/utils/money.js';
import { buildMeta, toSkipTake, type PaginationInput } from '../../common/utils/pagination.js';
import { getPaymentProvider, isPaymentsEnabled } from '../../integrations/payments/index.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { syncSubscriptionState } from './billing-events.service.js';

type Client = { ip?: string | undefined; userAgent?: string | undefined };

function toPaymentView(p: Prisma.PaymentGetPayload<object>) {
  const meta = (p.metadata ?? {}) as Record<string, unknown>;
  return {
    id: p.id,
    subscriptionId: p.subscriptionId,
    provider: p.provider,
    status: p.status,
    amountMinor: p.amountMinor,
    discountMinor: p.discountMinor,
    refundedMinor: p.refundedMinor,
    currency: p.currency,
    formattedAmount: formatMoney(p.amountMinor, p.currency),
    livemode: p.livemode,
    paidAt: p.paidAt?.toISOString() ?? null,
    failedAt: p.failedAt?.toISOString() ?? null,
    refundedAt: p.refundedAt?.toISOString() ?? null,
    failureCode: p.failureCode,
    // Only non-sensitive metadata is exposed (never checkout URLs or provider payloads).
    kind: typeof meta.kind === 'string' ? meta.kind : null,
    createdAt: p.createdAt.toISOString(),
  };
}

export const paymentsService = {
  async listMine(userId: string, query: PaginationInput) {
    const where = { userId };
    const [rows, total] = await prisma.$transaction([
      prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
      prisma.payment.count({ where }),
    ]);
    return { items: rows.map(toPaymentView), meta: buildMeta(query, total) };
  },

  async adminList(query: PaginationInput & { status?: PaymentStatus | undefined; userId?: string | undefined; from?: string | undefined; to?: string | undefined }) {
    const where: Prisma.PaymentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.from || query.to ? { createdAt: { gte: query.from ? new Date(query.from) : undefined, lt: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined } } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, include: { user: { select: { id: true, email: true } } }, ...toSkipTake(query) }),
      prisma.payment.count({ where }),
    ]);
    return { items: rows.map((p) => ({ ...toPaymentView(p), user: p.user })), meta: buildMeta(query, total) };
  },

  async adminGet(id: string) {
    const p = await prisma.payment.findUnique({ where: { id }, include: { user: { select: { id: true, email: true } }, redemption: { include: { coupon: { select: { code: true } } } } } });
    if (!p) throw AppError.notFound('Payment');
    return { ...toPaymentView(p), user: p.user, providerPaymentId: p.providerPaymentId, couponCode: p.redemption?.coupon.code ?? null };
  },

  /**
   * Starts a refund at the provider. The local payment/subscription state changes only when the
   * provider confirms with a `charge.refunded` webhook, keeping the provider the source of truth.
   */
  async refund(actor: AuthContext, id: string, input: { amountMinor?: number | undefined; reason: string }, client: Client) {
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw AppError.notFound('Payment');
    if (!['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(payment.status)) throw AppError.conflict('Only successful payments can be refunded');
    if (payment.provider === 'MANUAL') throw AppError.conflict('Manual payments are not refundable through a provider');
    if (!payment.providerChargeRef) throw AppError.conflict('Payment has no provider charge reference yet; try again after reconciliation');
    const refundable = payment.amountMinor - payment.refundedMinor;
    const amount = input.amountMinor ?? refundable;
    if (amount <= 0 || amount > refundable) throw AppError.validation([{ path: 'amountMinor', message: `Must be between 1 and ${refundable}` }]);

    const result = await getPaymentProvider().refund(payment.providerChargeRef, amount, `refund:${payment.id}:${payment.refundedMinor}:${amount}`);
    await writeAudit({
      actorId: actor.userId,
      action: 'payment.refund_requested',
      entityType: 'payment',
      entityId: id,
      severity: 'HIGH',
      metadata: { amountMinor: amount, currency: payment.currency, reason: input.reason, refundId: result.refundId },
      client,
    });
    return { refundId: result.refundId, status: result.status, amountMinor: amount, currency: payment.currency };
  },

  /**
   * Reconciliation job: re-reads provider state for subscriptions whose local period ended or
   * that are past due — recovers from missed/late webhooks using authenticated provider API calls.
   */
  async reconcile(now = new Date()) {
    if (!isPaymentsEnabled()) return 0;
    const provider = getPaymentProvider();
    const subs = await prisma.subscription.findMany({
      where: {
        provider: provider.name,
        providerSubscriptionId: { not: null },
        OR: [{ status: 'ACTIVE', currentPeriodEnd: { lt: now } }, { status: 'PAST_DUE' }],
      },
      take: 100,
    });
    let synced = 0;
    for (const sub of subs) {
      try {
        const state = await provider.getSubscription(sub.providerSubscriptionId as string);
        await prisma.$transaction(async (tx) => {
          await syncSubscriptionState(tx, state);
          // An active provider subscription with a newer period proves the renewal was paid.
          if ((state.status === 'active' || state.status === 'trialing') && state.currentPeriodEnd && state.currentPeriodEnd > now) {
            await tx.subscription.update({
              where: { id: sub.id },
              data: { status: 'ACTIVE', currentPeriodStart: state.currentPeriodStart, currentPeriodEnd: state.currentPeriodEnd },
            });
          }
        });
        synced++;
      } catch (err) {
        logger.warn({ subscriptionId: sub.id, err: (err as Error).message }, 'Reconciliation failed for subscription');
      }
    }
    return synced;
  },
};
