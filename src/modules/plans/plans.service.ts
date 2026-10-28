import type { SubscriptionPlan } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { formatMoney } from '../../common/utils/money.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import type { z } from 'zod';
import type { createPlanBody, updatePlanBody } from './plans.schemas.js';

type Actor = { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } };

export function toPlanView(p: SubscriptionPlan) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    priceMinor: p.priceMinor,
    currency: p.currency,
    formattedPrice: formatMoney(p.priceMinor, p.currency),
    billingInterval: p.billingInterval,
    intervalCount: p.intervalCount,
    trialDays: p.trialDays,
    features: p.features,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
  };
}

export const plansService = {
  listActive() {
    return cache.wrap(CacheNamespace.PLANS, 'active', 600, async () => {
      const plans = await prisma.subscriptionPlan.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }] });
      return plans.map(toPlanView);
    });
  },

  async listAll() {
    return (await prisma.subscriptionPlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }] })).map(toPlanView);
  },

  /** Loads a purchasable plan — price always comes from the database, never from the client. */
  async getPurchasable(planId: string): Promise<SubscriptionPlan> {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive) throw AppError.notFound('Plan');
    if (plan.priceMinor <= 0) throw AppError.badRequest('The free plan does not require a purchase');
    return plan;
  },

  async create(input: z.infer<typeof createPlanBody>, actor: Actor) {
    const plan = await prisma.subscriptionPlan.create({ data: { ...input, description: input.description ?? null } });
    await writeAudit({ actorId: actor.userId, action: 'plan.create', entityType: 'plan', entityId: plan.id, severity: 'MEDIUM', metadata: input, client: actor.client });
    await cache.invalidate(CacheNamespace.PLANS);
    return toPlanView(plan);
  },

  /**
   * Price changes never alter existing subscriptions: provider-side prices are immutable and a new
   * PlanProviderPrice is created on the next checkout; existing subscribers keep their price.
   */
  async update(id: string, input: z.infer<typeof updatePlanBody>, actor: Actor) {
    const existing = await prisma.subscriptionPlan.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound('Plan');
    const plan = await prisma.subscriptionPlan.update({ where: { id }, data: input });
    await writeAudit({
      actorId: actor.userId,
      action: 'plan.update',
      entityType: 'plan',
      entityId: id,
      severity: 'MEDIUM',
      metadata: { before: { priceMinor: existing.priceMinor, currency: existing.currency, isActive: existing.isActive }, changes: input },
      client: actor.client,
    });
    await cache.invalidate(CacheNamespace.PLANS);
    return toPlanView(plan);
  },
};
