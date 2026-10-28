import { z } from 'zod';
import { paginationQuery, sortQuery } from '../../common/utils/pagination.js';

export const ratingBody = z.object({ score: z.number().int().min(1).max(10) });
export const ratingResponse = z.object({ myRating: z.number().int().nullable(), average: z.number(), count: z.number().int() });

export const createReviewBody = z.object({
  title: z.string().trim().max(150).nullable().optional(),
  body: z.string().trim().min(10).max(5000),
  containsSpoilers: z.boolean().default(false),
});
export const updateReviewBody = createReviewBody.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const reportBody = z.object({
  reason: z.enum(['SPAM', 'SPOILER', 'ABUSE', 'HATE', 'OFF_TOPIC', 'OTHER']),
  details: z.string().trim().max(1000).optional(),
});

export const listReviewsQuery = paginationQuery.extend({ sort: sortQuery(['createdAt'], '-createdAt') });

export const adminReviewsQuery = paginationQuery.extend({
  status: z.enum(['VISIBLE', 'HIDDEN']).optional(),
  movieId: z.uuid().optional(),
  reported: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const adminReportsQuery = paginationQuery.extend({ status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).default('OPEN') });

export const moderationBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const resolveReportBody = z.object({ action: z.enum(['dismiss', 'hide']), reason: z.string().trim().min(3).max(500) });

export const reviewSchema = z.object({
  id: z.uuid(),
  movieId: z.uuid(),
  title: z.string().nullable(),
  body: z.string(),
  containsSpoilers: z.boolean(),
  author: z.object({ id: z.uuid(), displayName: z.string(), avatarUrl: z.string().nullable() }),
  myRating: z.number().int().nullable().describe("Author's rating of the movie"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const adminReviewSchema = reviewSchema.extend({ status: z.enum(['VISIBLE', 'HIDDEN']), reportCount: z.number().int(), deletedAt: z.string().nullable() });

export const reportSchema = z.object({
  id: z.uuid(),
  reason: z.string(),
  details: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  reporter: z.object({ id: z.uuid(), displayName: z.string() }),
  review: adminReviewSchema,
});

export const moderationLogSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  reason: z.string().nullable(),
  moderator: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  createdAt: z.string(),
});
