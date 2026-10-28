import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { idParam } from '../../common/utils/schemas.js';
import { collectionsService } from './collections.service.js';
import * as S from './collections.schemas.js';

const api = new ApiRouter('Catalog · Collections');
const admin = 'Admin · Catalog';
const actorOf = (ctx: { actor: () => { userId: string }; client: { ip?: string; userAgent?: string } }) => ({ userId: ctx.actor().userId, client: ctx.client });

api
  .route({
    method: 'get',
    path: '/collections',
    summary: 'Published collections',
    response: z.array(S.collectionSummarySchema),
    handler: async ({ res }) => sendSuccess(res, await collectionsService.list()),
  })
  .route({
    method: 'get',
    path: '/collections/:slug',
    summary: 'Collection with its movies',
    params: z.object({ slug: z.string().max(220) }),
    response: S.collectionDetailSchema,
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await collectionsService.getPublic(params.slug)),
  })
  .route({
    method: 'get',
    path: '/admin/collections',
    tags: [admin],
    summary: 'All collections',
    permissions: [PERMISSIONS.CONTENT_READ],
    response: z.array(S.adminCollectionSchema),
    handler: async ({ res }) => sendSuccess(res, await collectionsService.adminList()),
  })
  .route({
    method: 'post',
    path: '/admin/collections',
    tags: [admin],
    summary: 'Create collection',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    body: S.collectionBody,
    response: S.adminCollectionSchema,
    responseStatus: 201,
    errors: [409],
    handler: async (ctx) => sendCreated(ctx.res, await collectionsService.create(ctx.body, actorOf(ctx))),
  })
  .route({
    method: 'patch',
    path: '/admin/collections/:id',
    tags: [admin],
    summary: 'Update collection',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: S.updateCollectionBody,
    response: S.adminCollectionSchema,
    errors: [404, 409],
    handler: async (ctx) => sendSuccess(ctx.res, await collectionsService.update(ctx.params.id, ctx.body, actorOf(ctx))),
  })
  .route({
    method: 'put',
    path: '/admin/collections/:id/movies',
    tags: [admin],
    summary: 'Replace collection movies (order = array order)',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: S.setCollectionMoviesBody,
    response: S.adminCollectionSchema,
    errors: [404],
    handler: async (ctx) => sendSuccess(ctx.res, await collectionsService.setMovies(ctx.params.id, ctx.body.movieIds, actorOf(ctx))),
  })
  .route({
    method: 'delete',
    path: '/admin/collections/:id',
    tags: [admin],
    summary: 'Delete collection',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: null,
    errors: [404],
    handler: async (ctx) => {
      await collectionsService.remove(ctx.params.id, actorOf(ctx));
      sendSuccess(ctx.res, null, { message: 'Collection deleted' });
    },
  });

export const collectionsRouter = api.router;
