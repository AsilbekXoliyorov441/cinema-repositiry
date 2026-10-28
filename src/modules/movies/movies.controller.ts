import type { z } from 'zod';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import type { RouteContext } from '../../common/http/api-router.js';
import type { idParam, slugOrIdParam } from '../../common/utils/schemas.js';
import { moviesService } from './movies.service.js';
import type * as S from './movies.schemas.js';

type IdParams = z.infer<typeof idParam>;
type SlugParams = z.infer<typeof slugOrIdParam>;
const actorOf = (ctx: RouteContext<unknown, unknown, unknown>) => ({ userId: ctx.actor().userId, client: ctx.client });

export const moviesController = {
  async list({ res, query }: RouteContext<undefined, S.ListMoviesQuery, undefined>) {
    const { items, meta } = await moviesService.list(query);
    sendSuccess(res, items, { meta });
  },

  shelf(kind: 'popular' | 'trending' | 'new' | 'top-rated' | 'featured') {
    return async ({ res, query }: RouteContext<undefined, z.infer<typeof S.shelfQuery>, undefined>) => {
      sendSuccess(res, await moviesService.shelf(kind, query.limit));
    };
  },

  async recommended({ res, query, auth }: RouteContext<undefined, z.infer<typeof S.shelfQuery>, undefined>) {
    sendSuccess(res, await moviesService.recommended(auth?.userId, query.limit));
  },

  async byGenre({ res, params, query }: RouteContext<{ slug: string }, S.ListMoviesQuery, undefined>) {
    const { items, meta } = await moviesService.byGenre(params.slug, query);
    sendSuccess(res, items, { meta });
  },

  async detail({ res, params, auth }: RouteContext<SlugParams, undefined, undefined>) {
    sendSuccess(res, await moviesService.detail(params.idOrSlug, auth?.userId));
  },

  async similar({ res, params, query }: RouteContext<SlugParams, z.infer<typeof S.shelfQuery>, undefined>) {
    sendSuccess(res, await moviesService.similar(params.idOrSlug, query.limit));
  },

  async adminList({ res, query }: RouteContext<undefined, z.infer<typeof S.adminListMoviesQuery>, undefined>) {
    const { items, meta } = await moviesService.adminList(query);
    sendSuccess(res, items, { meta });
  },

  async adminGet({ res, params }: RouteContext<IdParams, undefined, undefined>) {
    sendSuccess(res, await moviesService.adminGet(params.id));
  },

  async create(ctx: RouteContext<undefined, undefined, S.CreateMovieInput>) {
    sendCreated(ctx.res, await moviesService.create(ctx.body, actorOf(ctx)), 'Movie created');
  },

  async update(ctx: RouteContext<IdParams, undefined, S.UpdateMovieInput>) {
    sendSuccess(ctx.res, await moviesService.update(ctx.params.id, ctx.body, actorOf(ctx)), { message: 'Movie updated' });
  },

  status(status: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT') {
    return async (ctx: RouteContext<IdParams, undefined, undefined>) => {
      sendSuccess(ctx.res, await moviesService.setStatus(ctx.params.id, status, actorOf(ctx)), { message: `Movie ${status.toLowerCase()}` });
    };
  },

  async remove(ctx: RouteContext<IdParams, undefined, undefined>) {
    await moviesService.softDelete(ctx.params.id, actorOf(ctx));
    sendSuccess(ctx.res, null, { message: 'Movie deleted' });
  },

  async restore(ctx: RouteContext<IdParams, undefined, undefined>) {
    sendSuccess(ctx.res, await moviesService.restore(ctx.params.id, actorOf(ctx)), { message: 'Movie restored as draft' });
  },

  async setCast(ctx: RouteContext<IdParams, undefined, z.infer<typeof S.setCastBody>>) {
    sendSuccess(ctx.res, await moviesService.setCast(ctx.params.id, ctx.body, actorOf(ctx)));
  },

  async setCrew(ctx: RouteContext<IdParams, undefined, z.infer<typeof S.setCrewBody>>) {
    sendSuccess(ctx.res, await moviesService.setCrew(ctx.params.id, ctx.body, actorOf(ctx)));
  },

  async import(ctx: RouteContext<undefined, undefined, z.infer<typeof S.importMoviesBody>>) {
    sendCreated(ctx.res, await moviesService.import(ctx.body, actorOf(ctx)), 'Movies imported');
  },

  async export({ res, query }: RouteContext<undefined, z.infer<typeof S.exportQuery>, undefined>) {
    const file = await moviesService.export(query.format, query.status);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="movies-${new Date().toISOString().slice(0, 10)}.${query.format}"`);
    res.send(file.body);
  },
};
