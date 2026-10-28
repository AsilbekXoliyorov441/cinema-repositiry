import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { idParam } from '../../common/utils/schemas.js';
import { playbackService } from './playback.service.js';
import { videoAssetsService } from './video-assets.service.js';
import {
  createVideoBody,
  playbackResponseSchema,
  subtitleBody,
  subtitleSchema,
  updateVideoBody,
  videoAssetSchema,
} from './playback.schemas.js';

const api = new ApiRouter('Playback');
const admin = 'Admin · Videos';
const actorOf = (ctx: { actor: () => { userId: string }; client: { ip?: string; userAgent?: string } }) => ({ userId: ctx.actor().userId, client: ctx.client });

const playbackDescription =
  'Checks that the title is published, the viewer passes the age gate and — for PRO titles — has an active entitlement ' +
  '(evaluated from the database on every request). Returns playable sources; signed sources carry an expiry.';

api
  .route({
    method: 'get',
    path: '/playback/:movieId',
    summary: 'Get playback sources for a movie',
    description: playbackDescription,
    auth: 'user',
    params: z.object({ movieId: z.uuid() }),
    response: playbackResponseSchema,
    errors: [403, 404],
    handler: async ({ res, params, actor }) => sendSuccess(res, await playbackService.movie(actor(), params.movieId)),
  })
  .route({
    method: 'get',
    path: '/playback/episodes/:episodeId',
    summary: 'Get playback sources for an episode',
    description: playbackDescription,
    auth: 'user',
    params: z.object({ episodeId: z.uuid() }),
    response: playbackResponseSchema,
    errors: [403, 404],
    handler: async ({ res, params, actor }) => sendSuccess(res, await playbackService.episode(actor(), params.episodeId)),
  });

// ───── Admin: video sources & subtitles ─────
for (const kind of ['movies', 'episodes'] as const) {
  const owner = (id: string) => (kind === 'movies' ? { movieId: id } : { episodeId: id });
  api
    .route({
      method: 'get',
      path: `/admin/${kind}/:id/videos`,
      tags: [admin],
      summary: `List video sources of ${kind === 'movies' ? 'a movie' : 'an episode'}`,
      permissions: [PERMISSIONS.CONTENT_READ],
      params: idParam,
      response: z.array(videoAssetSchema),
      errors: [404],
      handler: async ({ res, params }) => sendSuccess(res, await videoAssetsService.list(owner(params.id))),
    })
    .route({
      method: 'post',
      path: `/admin/${kind}/:id/videos`,
      tags: [admin],
      summary: `Add a video source (URL) to ${kind === 'movies' ? 'a movie' : 'an episode'}`,
      description: 'Only https URLs on public hosts are accepted; embeds must be on EMBED_ALLOWED_HOSTS. No HTML/JS embeds.',
      permissions: [PERMISSIONS.CONTENT_WRITE],
      params: idParam,
      body: createVideoBody,
      response: videoAssetSchema,
      responseStatus: 201,
      errors: [404],
      handler: async (ctx) => sendCreated(ctx.res, await videoAssetsService.create(owner(ctx.params.id), ctx.body, actorOf(ctx))),
    })
    .route({
      method: 'get',
      path: `/admin/${kind}/:id/subtitles`,
      tags: [admin],
      summary: 'List subtitles',
      permissions: [PERMISSIONS.CONTENT_READ],
      params: idParam,
      response: z.array(subtitleSchema),
      errors: [404],
      handler: async ({ res, params }) => sendSuccess(res, await videoAssetsService.listSubtitles(owner(params.id))),
    })
    .route({
      method: 'post',
      path: `/admin/${kind}/:id/subtitles`,
      tags: [admin],
      summary: 'Add a WebVTT subtitle track',
      permissions: [PERMISSIONS.CONTENT_WRITE],
      params: idParam,
      body: subtitleBody,
      response: subtitleSchema,
      responseStatus: 201,
      errors: [404],
      handler: async (ctx) => sendCreated(ctx.res, await videoAssetsService.addSubtitle(owner(ctx.params.id), ctx.body, actorOf(ctx))),
    });
}

api
  .route({
    method: 'patch',
    path: '/admin/videos/:id',
    tags: [admin],
    summary: 'Update a video source',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: updateVideoBody,
    response: videoAssetSchema,
    errors: [404],
    handler: async (ctx) => sendSuccess(ctx.res, await videoAssetsService.update(ctx.params.id, ctx.body, actorOf(ctx))),
  })
  .route({
    method: 'delete',
    path: '/admin/videos/:id',
    tags: [admin],
    summary: 'Delete a video source',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: null,
    errors: [404],
    handler: async (ctx) => {
      await videoAssetsService.remove(ctx.params.id, actorOf(ctx));
      sendSuccess(ctx.res, null, { message: 'Video deleted' });
    },
  })
  .route({
    method: 'post',
    path: '/admin/videos/:id/check',
    tags: [admin],
    summary: 'Probe a video URL for availability (SSRF-guarded HEAD request)',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    response: z.object({ reachable: z.boolean(), status: z.number().int(), contentType: z.string().nullable(), video: videoAssetSchema }),
    errors: [400, 404],
    handler: async ({ res, params }) => sendSuccess(res, await videoAssetsService.check(params.id)),
  })
  .route({
    method: 'delete',
    path: '/admin/subtitles/:id',
    tags: [admin],
    summary: 'Delete a subtitle track',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: null,
    errors: [404],
    handler: async (ctx) => {
      await videoAssetsService.removeSubtitle(ctx.params.id, actorOf(ctx));
      sendSuccess(ctx.res, null, { message: 'Subtitle deleted' });
    },
  });

export const playbackRouter = api.router;
