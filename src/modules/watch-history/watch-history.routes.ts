import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { rateLimiters } from '../../common/middleware/rate-limit.js';
import { sendSuccess } from '../../common/http/response.js';
import { idParam } from '../../common/utils/schemas.js';
import { watchHistoryService } from './watch-history.service.js';
import { continueWatchingSchema, historyEntrySchema, historyQuery, progressBody, progressSchema } from './watch-history.schemas.js';

const api = new ApiRouter('Me · Watching');

const progressDescription =
  'Send every 10–30 seconds while playing and on pause/exit. Rate limited per user; writes within 5 s for the same title are coalesced. ' +
  'The catalog runtime is authoritative; out-of-range positions are rejected.';

api
  .route({
    method: 'put',
    path: '/me/progress/:movieId',
    summary: 'Save playback progress for a movie',
    description: progressDescription,
    auth: 'user',
    rateLimit: rateLimiters.progress,
    params: z.object({ movieId: z.uuid() }),
    body: progressBody,
    response: progressSchema,
    errors: [404],
    handler: async ({ res, params, body, actor }) => sendSuccess(res, await watchHistoryService.saveMovieProgress(actor().userId, params.movieId, body)),
  })
  .route({
    method: 'put',
    path: '/me/progress/episodes/:episodeId',
    summary: 'Save playback progress for an episode',
    description: progressDescription,
    auth: 'user',
    rateLimit: rateLimiters.progress,
    params: z.object({ episodeId: z.uuid() }),
    body: progressBody,
    response: progressSchema,
    errors: [404],
    handler: async ({ res, params, body, actor }) =>
      sendSuccess(res, await watchHistoryService.saveEpisodeProgress(actor().userId, params.episodeId, body)),
  })
  .route({
    method: 'get',
    path: '/me/progress/:movieId',
    summary: 'My progress for a movie',
    auth: 'user',
    params: z.object({ movieId: z.uuid() }),
    response: progressSchema.nullable(),
    handler: async ({ res, params, actor }) => sendSuccess(res, await watchHistoryService.getMovieProgress(actor().userId, params.movieId)),
  })
  .route({
    method: 'get',
    path: '/me/continue-watching',
    summary: 'Unfinished movies and episodes, most recent first',
    auth: 'user',
    query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
    response: z.array(continueWatchingSchema),
    handler: async ({ res, query, actor }) => sendSuccess(res, await watchHistoryService.continueWatching(actor().userId, query.limit)),
  })
  .route({
    method: 'get',
    path: '/me/history',
    summary: 'My watch history',
    auth: 'user',
    query: historyQuery,
    response: historyEntrySchema,
    paginated: true,
    handler: async ({ res, query, actor }) => {
      const { items, meta } = await watchHistoryService.history(actor().userId, query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'delete',
    path: '/me/history/:id',
    summary: 'Delete one history entry',
    auth: 'user',
    params: idParam,
    response: null,
    errors: [404],
    handler: async ({ res, params, actor }) => {
      await watchHistoryService.deleteEntry(actor().userId, params.id);
      sendSuccess(res, null, { message: 'Entry deleted' });
    },
  })
  .route({
    method: 'delete',
    path: '/me/history',
    summary: 'Clear my watch history and progress',
    auth: 'user',
    response: z.object({ deleted: z.number().int() }),
    handler: async ({ res, actor }) => sendSuccess(res, await watchHistoryService.clear(actor().userId), { message: 'History cleared' }),
  });

export const watchHistoryRouter = api.router;
