import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { watchlistService } from './watchlist.service.js';
import { addWatchlistBody, watchlistItemSchema, watchlistQuery, watchlistTargetParams } from './watchlist.schemas.js';

const api = new ApiRouter('Me · Watchlist');

api
  .route({
    method: 'get',
    path: '/me/watchlist',
    summary: 'My watchlist',
    auth: 'user',
    query: watchlistQuery,
    response: watchlistItemSchema,
    paginated: true,
    handler: async ({ res, query, actor }) => {
      const { items, meta } = await watchlistService.list(actor().userId, query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'post',
    path: '/me/watchlist',
    summary: 'Add a movie or series to my watchlist',
    auth: 'user',
    body: addWatchlistBody,
    response: z.object({ id: z.uuid(), addedAt: z.string() }),
    responseStatus: 201,
    errors: [404, 409],
    handler: async ({ res, body, actor }) => sendCreated(res, await watchlistService.add(actor().userId, body), 'Added to watchlist'),
  })
  .route({
    method: 'delete',
    path: '/me/watchlist/:type/:id',
    summary: 'Remove from my watchlist',
    auth: 'user',
    params: watchlistTargetParams,
    response: null,
    errors: [404],
    handler: async ({ res, params, actor }) => {
      await watchlistService.remove(actor().userId, params.type, params.id);
      sendSuccess(res, null, { message: 'Removed from watchlist' });
    },
  });

export const watchlistRouter = api.router;
