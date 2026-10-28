import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { rateLimiters } from '../../common/middleware/rate-limit.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { idParam } from '../../common/utils/schemas.js';
import { ratingsService } from '../ratings/ratings.service.js';
import { reviewsService } from './reviews.service.js';
import * as S from './reviews.schemas.js';

const api = new ApiRouter('Ratings & Reviews');
const admin = 'Admin · Moderation';
const movieParam = z.object({ movieId: z.uuid() });

api
  .route({
    method: 'put',
    path: '/movies/:movieId/rating',
    summary: 'Rate a movie (1–10) — creates or updates my rating',
    auth: 'user',
    rateLimit: rateLimiters.writeContent,
    params: movieParam,
    body: S.ratingBody,
    response: S.ratingResponse,
    errors: [404],
    handler: async ({ res, params, body, actor }) => sendSuccess(res, await ratingsService.rate(actor().userId, params.movieId, body.score)),
  })
  .route({
    method: 'delete',
    path: '/movies/:movieId/rating',
    summary: 'Remove my rating',
    auth: 'user',
    params: movieParam,
    response: S.ratingResponse,
    errors: [404],
    handler: async ({ res, params, actor }) => sendSuccess(res, await ratingsService.remove(actor().userId, params.movieId)),
  })
  .route({
    method: 'get',
    path: '/movies/:movieId/reviews',
    summary: 'Visible reviews of a movie',
    params: movieParam,
    query: S.listReviewsQuery,
    response: S.reviewSchema,
    paginated: true,
    handler: async ({ res, params, query }) => {
      const { items, meta } = await reviewsService.listForMovie(params.movieId, query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'post',
    path: '/movies/:movieId/reviews',
    summary: 'Write a review (one per movie)',
    description: 'Requires a verified email. May require having watched the movie (`reviews.requireWatched` setting).',
    requireVerifiedEmail: true,
    rateLimit: rateLimiters.writeContent,
    params: movieParam,
    body: S.createReviewBody,
    response: S.reviewSchema,
    responseStatus: 201,
    errors: [403, 404, 409],
    handler: async ({ res, params, body, actor }) => sendCreated(res, await reviewsService.create(actor(), params.movieId, body)),
  })
  .route({
    method: 'patch',
    path: '/reviews/:id',
    summary: 'Edit my review',
    auth: 'user',
    rateLimit: rateLimiters.writeContent,
    params: idParam,
    body: S.updateReviewBody,
    response: S.reviewSchema,
    errors: [404],
    handler: async ({ res, params, body, actor }) => sendSuccess(res, await reviewsService.update(actor(), params.id, body)),
  })
  .route({
    method: 'delete',
    path: '/reviews/:id',
    summary: 'Delete a review (author, or moderator)',
    auth: 'user',
    params: idParam,
    response: null,
    errors: [404],
    handler: async ({ res, params, actor, client }) => {
      await reviewsService.remove(actor(), params.id, client);
      sendSuccess(res, null, { message: 'Review deleted' });
    },
  })
  .route({
    method: 'post',
    path: '/reviews/:id/report',
    summary: 'Report a review',
    auth: 'user',
    rateLimit: rateLimiters.writeContent,
    params: idParam,
    body: S.reportBody,
    response: null,
    responseStatus: 201,
    errors: [400, 404, 409],
    handler: async ({ res, params, body, actor }) => {
      await reviewsService.report(actor(), params.id, body);
      sendSuccess(res, null, { status: 201, message: 'Report submitted' });
    },
  })
  // ───── Moderation ─────
  .route({
    method: 'get',
    path: '/admin/reviews',
    tags: [admin],
    summary: 'List reviews for moderation',
    permissions: [PERMISSIONS.REVIEWS_MODERATE],
    query: S.adminReviewsQuery,
    response: S.adminReviewSchema,
    paginated: true,
    handler: async ({ res, query }) => {
      const { items, meta } = await reviewsService.adminList(query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'post',
    path: '/admin/reviews/:id/hide',
    tags: [admin],
    summary: 'Hide a review',
    permissions: [PERMISSIONS.REVIEWS_MODERATE],
    params: idParam,
    body: S.moderationBody,
    response: S.adminReviewSchema,
    errors: [404, 409],
    handler: async ({ res, params, body, actor, client }) => sendSuccess(res, await reviewsService.setVisibility(actor(), params.id, true, body.reason, client)),
  })
  .route({
    method: 'post',
    path: '/admin/reviews/:id/unhide',
    tags: [admin],
    summary: 'Restore a hidden review',
    permissions: [PERMISSIONS.REVIEWS_MODERATE],
    params: idParam,
    body: S.moderationBody,
    response: S.adminReviewSchema,
    errors: [404, 409],
    handler: async ({ res, params, body, actor, client }) =>
      sendSuccess(res, await reviewsService.setVisibility(actor(), params.id, false, body.reason, client)),
  })
  .route({
    method: 'get',
    path: '/admin/reviews/:id/moderation-log',
    tags: [admin],
    summary: 'Moderation history of a review',
    permissions: [PERMISSIONS.REVIEWS_MODERATE],
    params: idParam,
    response: z.array(S.moderationLogSchema),
    handler: async ({ res, params }) => sendSuccess(res, await reviewsService.moderationLog(params.id)),
  })
  .route({
    method: 'get',
    path: '/admin/review-reports',
    tags: [admin],
    summary: 'Review reports queue',
    permissions: [PERMISSIONS.REPORTS_READ],
    query: S.adminReportsQuery,
    response: S.reportSchema,
    paginated: true,
    handler: async ({ res, query }) => {
      const { items, meta } = await reviewsService.listReports(query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'post',
    path: '/admin/review-reports/:id/resolve',
    tags: [admin],
    summary: 'Resolve a report (dismiss or hide the review)',
    permissions: [PERMISSIONS.REPORTS_READ, PERMISSIONS.REVIEWS_MODERATE],
    params: idParam,
    body: S.resolveReportBody,
    response: null,
    errors: [404],
    handler: async ({ res, params, body, actor, client }) => {
      await reviewsService.resolveReport(actor(), params.id, body.action, body.reason, client);
      sendSuccess(res, null, { message: 'Report resolved' });
    },
  });

export const reviewsRouter = api.router;
