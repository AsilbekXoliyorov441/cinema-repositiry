import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { addDays } from '../../common/utils/duration.js';
import { formatMoney } from '../../common/utils/money.js';

export interface DateRange {
  from: Date;
  to: Date; // exclusive
}

export function resolveRange(from?: string, to?: string): DateRange {
  const end = to ? addDays(new Date(`${to}T00:00:00.000Z`), 1) : new Date();
  const start = from ? new Date(`${from}T00:00:00.000Z`) : addDays(end, -30);
  return { from: start, to: end };
}

const REVENUE_STATUSES = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

/**
 * Revenue methodology (also in README):
 *  - Only live-mode payments are counted (test-mode payments are excluded).
 *  - gross   = Σ amountMinor of payments with status SUCCEEDED / PARTIALLY_REFUNDED / REFUNDED, by paidAt in range
 *  - refunds = Σ refundedMinor of those same payments
 *  - net     = gross − refunds
 *  - Amounts are never summed across currencies; each currency is reported separately in minor units.
 */
export async function revenueByCurrency(range: DateRange, livemode = true) {
  const rows = await prisma.payment.groupBy({
    by: ['currency'],
    where: { status: { in: [...REVENUE_STATUSES] }, livemode, paidAt: { gte: range.from, lt: range.to } },
    _sum: { amountMinor: true, refundedMinor: true },
    _count: { _all: true },
  });
  return rows.map((r) => {
    const gross = r._sum.amountMinor ?? 0;
    const refunds = r._sum.refundedMinor ?? 0;
    return { currency: r.currency, grossMinor: gross, refundsMinor: refunds, netMinor: gross - refunds, formattedNet: formatMoney(gross - refunds, r.currency), payments: r._count._all };
  });
}

export const analyticsService = {
  async dashboard(range: DateRange, livemode: boolean) {
    const now = new Date();
    const [
      totalUsers,
      activeUsers,
      newUsers,
      proSubscribers,
      revenue,
      paymentCounts,
      movieCounts,
      seriesTotal,
      popular,
      mostWatched,
      recentUsers,
      recentPayments,
    ] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { deletedAt: null, lastLoginAt: { gte: range.from, lt: range.to } } }),
      prisma.user.count({ where: { createdAt: { gte: range.from, lt: range.to } } }),
      prisma.subscription.count({ where: { status: 'ACTIVE', currentPeriodEnd: { gt: now }, plan: { features: { has: 'PRO_CONTENT' } } } }),
      revenueByCurrency(range, livemode),
      prisma.payment.groupBy({ by: ['status'], where: { livemode, createdAt: { gte: range.from, lt: range.to } }, _count: { _all: true } }),
      prisma.movie.groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.series.count({ where: { deletedAt: null } }),
      prisma.movie.findMany({ where: { deletedAt: null }, orderBy: { popularityScore: 'desc' }, take: 10, select: { id: true, title: true, slug: true, popularityScore: true, viewCount: true, ratingAvg: true } }),
      prisma.watchHistory.groupBy({
        by: ['movieId'],
        where: { movieId: { not: null }, watchedOn: { gte: range.from, lt: range.to } },
        _count: { _all: true },
        orderBy: { _count: { movieId: 'desc' } },
        take: 10,
      }),
      prisma.user.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, email: true, displayName: true, createdAt: true } }),
      prisma.payment.findMany({
        where: { livemode },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, status: true, amountMinor: true, currency: true, createdAt: true, user: { select: { id: true, email: true } } },
      }),
    ]);

    const watchedIds = mostWatched.map((m) => m.movieId).filter((id): id is string => Boolean(id));
    const watchedTitles = new Map((await prisma.movie.findMany({ where: { id: { in: watchedIds } }, select: { id: true, title: true, slug: true } })).map((m) => [m.id, m]));
    const countByStatus = (rows: { status: string; _count: { _all: number } }[]) => Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    const payments = countByStatus(paymentCounts);

    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      livemode,
      users: { total: totalUsers, activeInRange: activeUsers, newInRange: newUsers },
      subscriptions: { activePro: proSubscribers },
      revenue,
      payments: { succeeded: payments.SUCCEEDED ?? 0, failed: payments.FAILED ?? 0, refunded: (payments.REFUNDED ?? 0) + (payments.PARTIALLY_REFUNDED ?? 0), byStatus: payments },
      catalog: { movies: countByStatus(movieCounts), seriesTotal },
      topMovies: { popular, mostWatched: mostWatched.map((m) => ({ ...watchedTitles.get(m.movieId as string), views: m._count._all })) },
      recentUsers: recentUsers.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
      recentPayments: recentPayments.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
    };
  },

  async revenueSeries(range: DateRange, interval: 'day' | 'week' | 'month', livemode: boolean) {
    const rows = await prisma.$queryRaw<{ bucket: Date; currency: string; gross: bigint; refunds: bigint; count: bigint }[]>`
      SELECT date_trunc(${interval}, "paidAt") AS bucket, currency,
             SUM("amountMinor")::bigint AS gross, SUM("refundedMinor")::bigint AS refunds, COUNT(*)::bigint AS count
      FROM payments
      WHERE status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED') AND livemode = ${livemode}
        AND "paidAt" >= ${range.from} AND "paidAt" < ${range.to}
      GROUP BY bucket, currency ORDER BY bucket ASC`;
    return rows.map((r) => ({
      bucket: r.bucket.toISOString(),
      currency: r.currency,
      grossMinor: Number(r.gross),
      refundsMinor: Number(r.refunds),
      netMinor: Number(r.gross - r.refunds),
      payments: Number(r.count),
    }));
  },

  async signupSeries(range: DateRange, interval: 'day' | 'week' | 'month') {
    const rows = await prisma.$queryRaw<{ bucket: Date; count: bigint }[]>`
      SELECT date_trunc(${interval}, "createdAt") AS bucket, COUNT(*)::bigint AS count
      FROM users WHERE "createdAt" >= ${range.from} AND "createdAt" < ${range.to}
      GROUP BY bucket ORDER BY bucket ASC`;
    return rows.map((r) => ({ bucket: r.bucket.toISOString(), count: Number(r.count) }));
  },

  /**
   * Stats job: recomputes trending (views last 7 days) and popularity (views last 30 days,
   * weighted by rating) scores in two set-based UPDATEs — no per-row round trips.
   */
  async recomputeScores(now = new Date()) {
    const week = addDays(now, -7);
    const month = addDays(now, -30);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE movies m SET "trendingScore" = COALESCE(h.views, 0)
      FROM (SELECT m2.id, COUNT(wh.id) AS views FROM movies m2
            LEFT JOIN watch_history wh ON wh."movieId" = m2.id AND wh."watchedOn" >= ${week}
            GROUP BY m2.id) h
      WHERE m.id = h.id`);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE movies m SET "popularityScore" = COALESCE(h.views, 0) * (1 + m."ratingAvg" / 10.0) + LN(1 + m."ratingCount")
      FROM (SELECT m2.id, COUNT(wh.id) AS views FROM movies m2
            LEFT JOIN watch_history wh ON wh."movieId" = m2.id AND wh."watchedOn" >= ${month}
            GROUP BY m2.id) h
      WHERE m.id = h.id`);
  },
};
