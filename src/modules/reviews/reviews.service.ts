import type { ModerationAction, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import type { AuthContext } from '../../common/types/auth.js';
import { publicContentWhere } from '../../common/utils/content.js';
import { buildMeta, toSkipTake, type PaginationInput } from '../../common/utils/pagination.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { imageSelect, toImageView } from '../media/media.urls.js';
import { notificationsService } from '../notifications/notifications.service.js';
import { settingsService } from '../settings/settings.service.js';
import type { z } from 'zod';
import type { adminReportsQuery, adminReviewsQuery, createReviewBody, reportBody, updateReviewBody } from './reviews.schemas.js';

type Client = { ip?: string | undefined; userAgent?: string | undefined };

const reviewInclude = {
  user: { select: { id: true, displayName: true, avatar: { select: imageSelect }, ratings: { select: { movieId: true, score: true } } } },
} satisfies Prisma.ReviewInclude;
type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof reviewInclude }>;

function toReview(r: ReviewRow) {
  return {
    id: r.id,
    movieId: r.movieId,
    title: r.title,
    body: r.body,
    containsSpoilers: r.containsSpoilers,
    author: { id: r.user.id, displayName: r.user.displayName, avatarUrl: toImageView(r.user.avatar)?.url ?? null },
    myRating: r.user.ratings.find((x) => x.movieId === r.movieId)?.score ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toAdminReview(r: ReviewRow) {
  return { ...toReview(r), status: r.status, reportCount: r.reportCount, deletedAt: r.deletedAt?.toISOString() ?? null };
}

/** Limits the author's ratings join to the reviewed movie (avoids loading every rating of the user). */
function includeFor(movieId?: string) {
  return {
    user: {
      select: {
        ...reviewInclude.user.select,
        ratings: { where: movieId ? { movieId } : undefined, select: { movieId: true, score: true } },
      },
    },
  } satisfies Prisma.ReviewInclude;
}

async function logModeration(tx: Tx, reviewId: string, moderatorId: string, action: ModerationAction, reason: string | null) {
  await tx.reviewModerationLog.create({ data: { reviewId, moderatorId, action, reason } });
}

export const reviewsService = {
  async listForMovie(movieId: string, query: PaginationInput) {
    const where: Prisma.ReviewWhereInput = { movieId, status: 'VISIBLE', deletedAt: null, movie: publicContentWhere() };
    const [rows, total] = await prisma.$transaction([
      prisma.review.findMany({ where, orderBy: { createdAt: 'desc' }, include: includeFor(movieId), ...toSkipTake(query) }),
      prisma.review.count({ where }),
    ]);
    return { items: rows.map(toReview), meta: buildMeta(query, total) };
  },

  async create(auth: AuthContext, movieId: string, input: z.infer<typeof createReviewBody>) {
    const movie = await prisma.movie.findFirst({ where: { id: movieId, ...publicContentWhere() }, select: { id: true } });
    if (!movie) throw AppError.notFound('Movie');

    if (await settingsService.get('reviews.requireWatched')) {
      const watched = await prisma.watchHistory.findFirst({ where: { userId: auth.userId, movieId }, select: { id: true } });
      if (!watched) throw AppError.forbidden('You can review a movie after watching it');
    }

    const existing = await prisma.review.findUnique({ where: { userId_movieId: { userId: auth.userId, movieId } } });
    if (existing && !existing.deletedAt) throw AppError.conflict('You have already reviewed this movie');

    const data = { title: input.title ?? null, body: input.body, containsSpoilers: input.containsSpoilers };
    const review = existing
      ? // A previously deleted review is replaced, keeping the one-review-per-user constraint.
        await prisma.review.update({
          where: { id: existing.id },
          data: { ...data, deletedAt: null, status: 'VISIBLE', reportCount: 0, createdAt: new Date() },
          include: includeFor(movieId),
        })
      : await prisma.review.create({ data: { ...data, userId: auth.userId, movieId }, include: includeFor(movieId) });
    return toReview(review);
  },

  async update(auth: AuthContext, id: string, input: z.infer<typeof updateReviewBody>) {
    const review = await prisma.review.findFirst({ where: { id, deletedAt: null } });
    // Ownership check: a foreign review looks like a missing one.
    if (!review || review.userId !== auth.userId) throw AppError.notFound('Review');
    const updated = await prisma.review.update({ where: { id }, data: input, include: includeFor(review.movieId) });
    return toReview(updated);
  },

  async remove(auth: AuthContext, id: string, client: Client) {
    const review = await prisma.review.findFirst({ where: { id, deletedAt: null } });
    if (!review) throw AppError.notFound('Review');
    const isOwner = review.userId === auth.userId;
    const isModerator = auth.permissions.has(PERMISSIONS.REVIEWS_MODERATE);
    if (!isOwner && !isModerator) throw AppError.notFound('Review');

    await prisma.$transaction(async (tx) => {
      await tx.review.update({ where: { id }, data: { deletedAt: new Date() } });
      if (!isOwner) {
        await logModeration(tx, id, auth.userId, 'DELETE', null);
        await writeAudit({ actorId: auth.userId, action: 'review.delete', entityType: 'review', entityId: id, client }, tx);
      }
    });
  },

  async report(auth: AuthContext, id: string, input: z.infer<typeof reportBody>) {
    const review = await prisma.review.findFirst({ where: { id, deletedAt: null, status: 'VISIBLE' } });
    if (!review) throw AppError.notFound('Review');
    if (review.userId === auth.userId) throw AppError.badRequest('You cannot report your own review');
    const threshold = await settingsService.get('reviews.autoHideReportThreshold');

    await prisma.$transaction(async (tx) => {
      // Unique (reviewId, reporterId) makes repeated reports a 409 instead of inflating counts.
      await tx.reviewReport.create({ data: { reviewId: id, reporterId: auth.userId, reason: input.reason, details: input.details ?? null } });
      const updated = await tx.review.update({ where: { id }, data: { reportCount: { increment: 1 } }, select: { reportCount: true } });
      if (threshold > 0 && updated.reportCount >= threshold) {
        await tx.review.update({ where: { id }, data: { status: 'HIDDEN' } });
        await tx.reviewModerationLog.create({ data: { reviewId: id, moderatorId: null, action: 'HIDE', reason: `Auto-hidden after ${threshold} reports` } });
      }
    });
  },

  // ───── Moderation ─────

  async adminList(query: z.infer<typeof adminReviewsQuery>) {
    const where: Prisma.ReviewWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.movieId ? { movieId: query.movieId } : {}),
      ...(query.reported ? { reportCount: { gt: 0 } } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.review.findMany({ where, orderBy: [{ reportCount: 'desc' }, { createdAt: 'desc' }], include: includeFor(), ...toSkipTake(query) }),
      prisma.review.count({ where }),
    ]);
    return { items: rows.map(toAdminReview), meta: buildMeta(query, total) };
  },

  async setVisibility(auth: AuthContext, id: string, hide: boolean, reason: string, client: Client) {
    const review = await prisma.review.findFirst({ where: { id, deletedAt: null } });
    if (!review) throw AppError.notFound('Review');
    const target = hide ? 'HIDDEN' : 'VISIBLE';
    if (review.status === target) throw AppError.conflict(`Review is already ${target.toLowerCase()}`);

    const updated = await prisma.$transaction(async (tx) => {
      const r = await tx.review.update({ where: { id }, data: { status: target, ...(hide ? {} : { reportCount: 0 }) }, include: includeFor(review.movieId) });
      await logModeration(tx, id, auth.userId, hide ? 'HIDE' : 'UNHIDE', reason);
      if (!hide) {
        await tx.reviewReport.updateMany({ where: { reviewId: id, status: 'OPEN' }, data: { status: 'DISMISSED', resolvedById: auth.userId, resolvedAt: new Date() } });
      }
      await writeAudit({ actorId: auth.userId, action: hide ? 'review.hide' : 'review.unhide', entityType: 'review', entityId: id, metadata: { reason }, client }, tx);
      return r;
    });
    if (hide) {
      await notificationsService.notify({
        userId: review.userId,
        type: 'REVIEW_HIDDEN',
        title: 'Your review was hidden',
        body: 'A moderator hid your review because it violates the community guidelines.',
        data: { reviewId: id },
      });
    }
    return toAdminReview(updated);
  },

  async listReports(query: z.infer<typeof adminReportsQuery>) {
    const where: Prisma.ReviewReportWhereInput = { status: query.status };
    const [rows, total] = await prisma.$transaction([
      prisma.reviewReport.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        include: { reporter: { select: { id: true, displayName: true } }, review: { include: includeFor() } },
        ...toSkipTake(query),
      }),
      prisma.reviewReport.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        details: r.details,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        reporter: r.reporter,
        review: toAdminReview(r.review),
      })),
      meta: buildMeta(query, total),
    };
  },

  async resolveReport(auth: AuthContext, reportId: string, action: 'dismiss' | 'hide', reason: string, client: Client) {
    const report = await prisma.reviewReport.findUnique({ where: { id: reportId }, include: { review: true } });
    if (!report || report.status !== 'OPEN') throw AppError.notFound('Open report');

    if (action === 'hide' && report.review.status === 'VISIBLE') {
      await this.setVisibility(auth, report.reviewId, true, reason, client);
    }
    await prisma.$transaction(async (tx) => {
      // Hiding resolves every open report on the review; dismissing closes just this one.
      await tx.reviewReport.updateMany({
        where: action === 'hide' ? { reviewId: report.reviewId, status: 'OPEN' } : { id: reportId },
        data: { status: action === 'hide' ? 'RESOLVED' : 'DISMISSED', resolvedById: auth.userId, resolvedAt: new Date() },
      });
      if (action === 'dismiss') {
        await tx.review.update({ where: { id: report.reviewId }, data: { reportCount: { decrement: 1 } } });
      }
      await logModeration(tx, report.reviewId, auth.userId, action === 'hide' ? 'REPORT_RESOLVED' : 'REPORT_DISMISSED', reason);
    });
  },

  async moderationLog(reviewId: string) {
    const logs = await prisma.reviewModerationLog.findMany({
      where: { reviewId },
      orderBy: { createdAt: 'desc' },
      include: { moderator: { select: { id: true, displayName: true } } },
    });
    return logs.map((l) => ({ id: l.id, action: l.action, reason: l.reason, moderator: l.moderator, createdAt: l.createdAt.toISOString() }));
  },
};
