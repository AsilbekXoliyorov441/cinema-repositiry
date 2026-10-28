import type { Job } from 'bullmq';
import { prisma } from '../../config/database.js';
import { addDays } from '../../common/utils/duration.js';
import { analyticsService } from '../../modules/analytics/analytics.service.js';
import { couponsService } from '../../modules/coupons/coupons.service.js';
import { paymentsService } from '../../modules/payments/payments.service.js';
import { subscriptionsService } from '../../modules/subscriptions/subscriptions.service.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { MAINTENANCE_JOBS, type MaintenanceJobName } from '../queues.js';
import { processOrphanMedia } from './media-cleanup.processor.js';

async function cleanupTokens(now = new Date()) {
  const weekAgo = addDays(now, -7);
  const monthAgo = addDays(now, -30);
  const [refresh, sessions, verification, resets] = await prisma.$transaction([
    prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: weekAgo } } }),
    prisma.session.deleteMany({ where: { OR: [{ revokedAt: { lt: monthAgo } }, { expiresAt: { lt: monthAgo } }] } }),
    prisma.verificationToken.deleteMany({ where: { OR: [{ expiresAt: { lt: weekAgo } }, { usedAt: { lt: weekAgo } }] } }),
    prisma.passwordResetToken.deleteMany({ where: { OR: [{ expiresAt: { lt: weekAgo } }, { usedAt: { lt: weekAgo } }] } }),
  ]);
  return { refresh: refresh.count, sessions: sessions.count, verification: verification.count, resets: resets.count };
}

/** Every maintenance job is idempotent: running it twice (retries, overlapping schedules) is harmless. */
export async function processMaintenanceJob(job: Job): Promise<unknown> {
  switch (job.name as MaintenanceJobName) {
    case MAINTENANCE_JOBS.EXPIRE_SUBSCRIPTIONS:
      return { expired: await subscriptionsService.expireDue() };
    case MAINTENANCE_JOBS.SUBSCRIPTION_REMINDERS:
      return { reminded: await subscriptionsService.sendExpiryReminders() };
    case MAINTENANCE_JOBS.RECONCILE_PAYMENTS:
      return { synced: await paymentsService.reconcile() };
    case MAINTENANCE_JOBS.RELEASE_COUPON_RESERVATIONS:
      return { released: await couponsService.releaseExpiredReservations() };
    case MAINTENANCE_JOBS.ORPHAN_MEDIA:
      return processOrphanMedia();
    case MAINTENANCE_JOBS.COMPUTE_STATS:
      await analyticsService.recomputeScores();
      await cache.invalidate(CacheNamespace.CATALOG);
      return { ok: true };
    case MAINTENANCE_JOBS.CLEANUP_TOKENS:
      return cleanupTokens();
    default:
      throw new Error(`Unknown maintenance job: ${job.name}`);
  }
}
