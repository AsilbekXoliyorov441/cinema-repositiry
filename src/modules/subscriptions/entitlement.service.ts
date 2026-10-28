import { prisma } from '../../config/database.js';
import { evaluateEntitlement, type Entitlement } from './entitlement.js';

/**
 * Loads entitlement straight from PostgreSQL on every call. It is intentionally NOT cached:
 * premium access must never be granted from stale cache data or when Redis is unavailable.
 */
export const entitlementService = {
  async forUser(userId: string, now = new Date()): Promise<Entitlement> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { currentPeriodEnd: 'desc' },
          take: 1,
          select: {
            status: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            plan: { select: { features: true } },
            payments: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
          },
        },
      },
    });
    if (!user) return evaluateEntitlement({ userStatus: 'DELETED', subscription: null, now });
    const s = user.subscriptions[0];
    return evaluateEntitlement({
      userStatus: user.status,
      subscription: s
        ? {
            status: s.status,
            currentPeriodStart: s.currentPeriodStart,
            currentPeriodEnd: s.currentPeriodEnd,
            features: s.plan.features,
            latestPaymentStatus: s.payments[0]?.status ?? null,
          }
        : null,
      now,
    });
  },
};
