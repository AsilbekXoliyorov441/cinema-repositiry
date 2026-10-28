import type { Coupon, Prisma, SubscriptionPlan } from '@prisma/client';
import { prisma, type Tx } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { buildMeta, toSkipTake, type PaginationInput } from '../../common/utils/pagination.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { COUPON_REJECTION_MESSAGES, evaluateCoupon, type CouponEvaluation } from './coupon.policy.js';
import type { z } from 'zod';
import type { createCouponBody, updateCouponBody } from './coupons.schemas.js';

type Actor = { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } };
const ACTIVE_REDEMPTION = { in: ['RESERVED', 'REDEEMED'] as ('RESERVED' | 'REDEEMED')[] };

async function evaluateFor(db: Tx | typeof prisma, coupon: Coupon, plan: SubscriptionPlan, userId: string): Promise<CouponEvaluation> {
  const [eligible, usedTotal, usedByUser] = await Promise.all([
    db.couponPlan.findMany({ where: { couponId: coupon.id }, select: { planId: true } }),
    db.couponRedemption.count({ where: { couponId: coupon.id, status: ACTIVE_REDEMPTION } }),
    db.couponRedemption.count({ where: { couponId: coupon.id, userId, status: ACTIVE_REDEMPTION } }),
  ]);
  return evaluateCoupon(coupon, {
    plan,
    eligiblePlanIds: eligible.map((e) => e.planId),
    usedTotal,
    usedByUser,
    now: new Date(),
  });
}

function toView(c: Coupon & { plans: { planId: string }[]; redemptions: { status: string }[] }) {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    discountType: c.discountType,
    percentOff: c.percentOff,
    amountOffMinor: c.amountOffMinor,
    currency: c.currency,
    startsAt: c.startsAt?.toISOString() ?? null,
    endsAt: c.endsAt?.toISOString() ?? null,
    maxRedemptions: c.maxRedemptions,
    perUserLimit: c.perUserLimit,
    minAmountMinor: c.minAmountMinor,
    isActive: c.isActive,
    planIds: c.plans.map((p) => p.planId),
    redeemedCount: c.redemptions.filter((r) => r.status === 'REDEEMED').length,
    reservedCount: c.redemptions.filter((r) => r.status === 'RESERVED').length,
  };
}

const viewInclude = { plans: { select: { planId: true } }, redemptions: { select: { status: true } } } satisfies Prisma.CouponInclude;

export const couponsService = {
  /** Read-only preview for the checkout page. The authoritative check happens again inside the checkout transaction. */
  async preview(userId: string, code: string, plan: SubscriptionPlan) {
    const coupon = await prisma.coupon.findUnique({ where: { code } });
    const base = { code, priceMinor: plan.priceMinor, currency: plan.currency };
    if (!coupon) return { ...base, valid: false, reason: 'Coupon not found', discountMinor: 0, finalMinor: plan.priceMinor };
    const result = await evaluateFor(prisma, coupon, plan, userId);
    return result.ok
      ? { ...base, valid: true, reason: null, discountMinor: result.discountMinor, finalMinor: result.finalMinor }
      : { ...base, valid: false, reason: COUPON_REJECTION_MESSAGES[result.reason], discountMinor: 0, finalMinor: plan.priceMinor };
  },

  /**
   * Reserves one redemption inside the caller's transaction. The coupon row is locked
   * (SELECT … FOR UPDATE), so concurrent checkouts are serialized and limits can never be exceeded.
   */
  async reserve(tx: Tx, params: { code: string; plan: SubscriptionPlan; userId: string; subscriptionId: string; paymentId: string; expiresAt: Date }) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM coupons WHERE code = ${params.code} FOR UPDATE`;
    if (!locked[0]) throw AppError.validation([{ path: 'couponCode', message: 'Coupon not found' }]);
    const coupon = await tx.coupon.findUniqueOrThrow({ where: { id: locked[0].id } });
    const result = await evaluateFor(tx, coupon, params.plan, params.userId);
    if (!result.ok) throw AppError.validation([{ path: 'couponCode', message: COUPON_REJECTION_MESSAGES[result.reason] }]);
    await tx.couponRedemption.create({
      data: {
        couponId: coupon.id,
        userId: params.userId,
        subscriptionId: params.subscriptionId,
        paymentId: params.paymentId,
        discountMinor: result.discountMinor,
        currency: result.currency,
        expiresAt: params.expiresAt,
      },
    });
    return result;
  },

  async markRedeemed(tx: Tx, paymentId: string) {
    await tx.couponRedemption.updateMany({ where: { paymentId, status: 'RESERVED' }, data: { status: 'REDEEMED', redeemedAt: new Date() } });
  },

  async release(tx: Tx, where: { paymentId?: string; subscriptionId?: string }) {
    await tx.couponRedemption.updateMany({ where: { ...where, status: 'RESERVED' }, data: { status: 'RELEASED' } });
  },

  /** Background job: frees reservations of abandoned checkouts. */
  async releaseExpiredReservations(now = new Date()) {
    const r = await prisma.couponRedemption.updateMany({ where: { status: 'RESERVED', expiresAt: { lt: now } }, data: { status: 'RELEASED' } });
    return r.count;
  },

  // ───── Admin ─────

  async list(query: PaginationInput & { active?: boolean | undefined }) {
    const where: Prisma.CouponWhereInput = query.active === undefined ? {} : { isActive: query.active };
    const [rows, total] = await prisma.$transaction([
      prisma.coupon.findMany({ where, include: viewInclude, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
      prisma.coupon.count({ where }),
    ]);
    return { items: rows.map(toView), meta: buildMeta(query, total) };
  },

  async get(id: string) {
    const c = await prisma.coupon.findUnique({ where: { id }, include: viewInclude });
    if (!c) throw AppError.notFound('Coupon');
    return toView(c);
  },

  async create(input: z.infer<typeof createCouponBody>, actor: Actor) {
    const { planIds, ...data } = input;
    const coupon = await prisma.$transaction(async (tx) => {
      const c = await tx.coupon.create({
        data: {
          ...data,
          percentOff: data.discountType === 'PERCENT' ? data.percentOff : null,
          amountOffMinor: data.discountType === 'FIXED' ? data.amountOffMinor : null,
          currency: data.discountType === 'FIXED' ? data.currency : null,
          startsAt: data.startsAt ? new Date(data.startsAt) : null,
          endsAt: data.endsAt ? new Date(data.endsAt) : null,
          plans: { create: [...new Set(planIds)].map((planId) => ({ planId })) },
        },
      });
      await writeAudit({ actorId: actor.userId, action: 'coupon.create', entityType: 'coupon', entityId: c.id, severity: 'MEDIUM', metadata: { code: c.code }, client: actor.client }, tx);
      return c;
    });
    return this.get(coupon.id);
  },

  async update(id: string, input: z.infer<typeof updateCouponBody>, actor: Actor) {
    await this.get(id);
    const { planIds, ...data } = input;
    await prisma.$transaction(async (tx) => {
      await tx.coupon.update({
        where: { id },
        data: {
          ...data,
          startsAt: data.startsAt === undefined ? undefined : data.startsAt ? new Date(data.startsAt) : null,
          endsAt: data.endsAt === undefined ? undefined : data.endsAt ? new Date(data.endsAt) : null,
        },
      });
      if (planIds) {
        await tx.couponPlan.deleteMany({ where: { couponId: id } });
        await tx.couponPlan.createMany({ data: [...new Set(planIds)].map((planId) => ({ couponId: id, planId })) });
      }
      await writeAudit({ actorId: actor.userId, action: 'coupon.update', entityType: 'coupon', entityId: id, metadata: input, client: actor.client }, tx);
    });
    return this.get(id);
  },
};
