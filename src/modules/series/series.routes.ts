import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { idParam, slugOrIdParam } from '../../common/utils/schemas.js';
import { CONTENT_STATUS } from '../../common/utils/content.js';
import { episodesService, seasonsService } from '../episodes/episodes.service.js';
import { adminEpisodeSchema, createEpisodeBody, episodeSchema, seasonWithEpisodesSchema, updateEpisodeBody } from '../episodes/episodes.schemas.js';
import { createSeasonBody, seasonParams, updateSeasonBody } from '../seasons/seasons.schemas.js';
import { seriesService } from './series.service.js';
import * as S from './series.schemas.js';

const api = new ApiRouter('Catalog · Series');
const admin = 'Admin · Series';
const actorOf = (ctx: { actor: () => { userId: string }; client: { ip?: string; userAgent?: string } }) => ({
  userId: ctx.actor().userId,
  client: ctx.client,
});
const seasonRecord = z.object({
  id: z.uuid(),
  seriesId: z.uuid(),
  seasonNumber: z.number().int(),
  title: z.string().nullable(),
  overview: z.string().nullable(),
  airDate: z.string().nullable(),
  posterImageId: z.uuid().nullable(),
  status: z.enum(CONTENT_STATUS),
});

api
  .route({
    method: 'get',
    path: '/series',
    summary: 'Browse series',
    query: S.listSeriesQuery,
    response: S.seriesSummarySchema,
    paginated: true,
    handler: async ({ res, query }) => {
      const { items, meta } = await seriesService.list(query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'get',
    path: '/series/:idOrSlug',
    summary: 'Series details with published seasons',
    params: slugOrIdParam,
    response: S.seriesDetailSchema,
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await seriesService.detail(params.idOrSlug)),
  })
  .route({
    method: 'get',
    path: '/series/:idOrSlug/seasons/:seasonNumber',
    summary: 'Season with its published episodes',
    params: seasonParams,
    response: seasonWithEpisodesSchema,
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await seasonsService.publicSeason(params.idOrSlug, params.seasonNumber)),
  })
  .route({
    method: 'get',
    path: '/episodes/:id',
    summary: 'Episode details',
    params: idParam,
    response: episodeSchema,
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await episodesService.publicEpisode(params.id)),
  })
  // ───── Admin: series ─────
  .route({
    method: 'get',
    path: '/admin/series',
    tags: [admin],
    summary: 'List series (any status)',
    permissions: [PERMISSIONS.CONTENT_READ],
    query: S.adminListSeriesQuery,
    response: S.adminSeriesSchema,
    paginated: true,
    handler: async ({ res, query }) => {
      const { items, meta } = await seriesService.adminList(query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'post',
    path: '/admin/series',
    tags: [admin],
    summary: 'Create series',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    body: S.createSeriesBody,
    response: S.adminSeriesSchema,
    responseStatus: 201,
    errors: [409],
    handler: async (ctx) => sendCreated(ctx.res, await seriesService.create(ctx.body, actorOf(ctx))),
  })
  .route({
    method: 'get',
    path: '/admin/series/:id',
    tags: [admin],
    summary: 'Series details (admin)',
    permissions: [PERMISSIONS.CONTENT_READ],
    params: idParam,
    response: S.adminSeriesSchema,
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await seriesService.adminGet(params.id)),
  })
  .route({
    method: 'patch',
    path: '/admin/series/:id',
    tags: [admin],
    summary: 'Update series',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: S.updateSeriesBody,
    response: S.adminSeriesSchema,
    errors: [404, 409],
    handler: async (ctx) => sendSuccess(ctx.res, await seriesService.update(ctx.params.id, ctx.body, actorOf(ctx))),
  })
  .route({
    method: 'post',
    path: '/admin/series/:id/status',
    tags: [admin],
    summary: 'Publish / unpublish / archive series',
    permissions: [PERMISSIONS.CONTENT_PUBLISH],
    params: idParam,
    body: z.object({ status: z.enum(CONTENT_STATUS) }),
    response: S.adminSeriesSchema,
    errors: [404],
    handler: async (ctx) => sendSuccess(ctx.res, await seriesService.setStatus(ctx.params.id, ctx.body.status, actorOf(ctx))),
  })
  .route({
    method: 'delete',
    path: '/admin/series/:id',
    tags: [admin],
    summary: 'Soft-delete series',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: null,
    errors: [404],
    handler: async (ctx) => {
      await seriesService.softDelete(ctx.params.id, actorOf(ctx));
      sendSuccess(ctx.res, null, { message: 'Series deleted' });
    },
  })
  // ───── Admin: seasons ─────
  .route({
    method: 'post',
    path: '/admin/series/:id/seasons',
    tags: [admin],
    summary: 'Add a season',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: createSeasonBody,
    response: seasonRecord,
    responseStatus: 201,
    errors: [404, 409],
    handler: async (ctx) => sendCreated(ctx.res, await seasonsService.create(ctx.params.id, ctx.body, actorOf(ctx))),
  })
  .route({
    method: 'patch',
    path: '/admin/seasons/:id',
    tags: [admin],
    summary: 'Update a season (including status)',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: updateSeasonBody,
    response: seasonRecord,
    errors: [404, 409],
    handler: async (ctx) => sendSuccess(ctx.res, await seasonsService.update(ctx.params.id, ctx.body, actorOf(ctx))),
  })
  .route({
    method: 'delete',
    path: '/admin/seasons/:id',
    tags: [admin],
    summary: 'Soft-delete a season',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: null,
    errors: [404],
    handler: async (ctx) => {
      await seasonsService.remove(ctx.params.id, actorOf(ctx));
      sendSuccess(ctx.res, null, { message: 'Season deleted' });
    },
  })
  // ───── Admin: episodes ─────
  .route({
    method: 'get',
    path: '/admin/seasons/:id/episodes',
    tags: [admin],
    summary: 'List episodes of a season (any status)',
    permissions: [PERMISSIONS.CONTENT_READ],
    params: idParam,
    response: z.array(adminEpisodeSchema),
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await episodesService.adminList(params.id)),
  })
  .route({
    method: 'post',
    path: '/admin/seasons/:id/episodes',
    tags: [admin],
    summary: 'Add an episode',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: createEpisodeBody,
    response: adminEpisodeSchema,
    responseStatus: 201,
    errors: [404, 409],
    handler: async (ctx) => sendCreated(ctx.res, await episodesService.create(ctx.params.id, ctx.body, actorOf(ctx))),
  })
  .route({
    method: 'patch',
    path: '/admin/episodes/:id',
    tags: [admin],
    summary: 'Update an episode (including status)',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: updateEpisodeBody,
    response: adminEpisodeSchema,
    errors: [404, 409],
    handler: async (ctx) => sendSuccess(ctx.res, await episodesService.update(ctx.params.id, ctx.body, actorOf(ctx))),
  })
  .route({
    method: 'delete',
    path: '/admin/episodes/:id',
    tags: [admin],
    summary: 'Soft-delete an episode',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: null,
    errors: [404],
    handler: async (ctx) => {
      await episodesService.remove(ctx.params.id, actorOf(ctx));
      sendSuccess(ctx.res, null, { message: 'Episode deleted' });
    },
  });

export const seriesRouter = api.router;
