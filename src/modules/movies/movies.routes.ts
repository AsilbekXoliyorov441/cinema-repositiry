import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { idParam, slugOrIdParam } from '../../common/utils/schemas.js';
import { moviesController as c } from './movies.controller.js';
import * as S from './movies.schemas.js';

const api = new ApiRouter('Catalog · Movies');
const admin = 'Admin · Movies';
const summaries = z.array(S.movieSummarySchema);

const shelves = [
  ['popular', 'Popular movies (by popularity score from views and ratings)'],
  ['trending', 'Trending movies (views in the last 7 days)'],
  ['new', 'Recently added movies'],
  ['top-rated', 'Top rated movies (minimum 3 votes)'],
  ['featured', 'Featured movies picked by editors'],
] as const;

api.route({
  method: 'get',
  path: '/movies',
  summary: 'Browse and search movies',
  description: 'Filter by genre, year range, country, language, age rating and access tier; sort with `sort=-rating` etc.',
  query: S.listMoviesQuery,
  response: S.movieSummarySchema,
  paginated: true,
  handler: c.list,
});

for (const [kind, summary] of shelves) {
  api.route({ method: 'get', path: `/movies/${kind}`, summary, query: S.shelfQuery, response: summaries, handler: c.shelf(kind) });
}

api
  .route({
    method: 'get',
    path: '/movies/recommended',
    summary: 'Recommended movies (personalized when authenticated)',
    auth: 'optional',
    query: S.shelfQuery,
    response: summaries,
    handler: c.recommended,
  })
  .route({
    method: 'get',
    path: '/genres/:slug/movies',
    tags: ['Catalog · Genres'],
    summary: 'Movies in a genre',
    params: z.object({ slug: z.string().max(100) }),
    query: S.listMoviesQuery.omit({ genre: true }),
    response: S.movieSummarySchema,
    paginated: true,
    errors: [404],
    handler: (ctx) => c.byGenre({ ...ctx, query: { ...ctx.query, genre: undefined } }),
  })
  .route({
    method: 'get',
    path: '/movies/:idOrSlug',
    summary: 'Movie details',
    description: 'Includes `viewer` (watchlist, my rating, progress) when authenticated. Never includes video URLs.',
    auth: 'optional',
    params: slugOrIdParam,
    response: S.movieDetailSchema,
    errors: [404],
    handler: c.detail,
  })
  .route({
    method: 'get',
    path: '/movies/:idOrSlug/similar',
    summary: 'Similar movies (shared genres)',
    params: slugOrIdParam,
    query: S.shelfQuery,
    response: summaries,
    errors: [404],
    handler: c.similar,
  })
  // ───── Admin ─────
  .route({
    method: 'get',
    path: '/admin/movies',
    tags: [admin],
    summary: 'List all movies (any status)',
    permissions: [PERMISSIONS.CONTENT_READ],
    query: S.adminListMoviesQuery,
    response: S.adminMovieSchema,
    paginated: true,
    handler: c.adminList,
  })
  .route({
    method: 'get',
    path: '/admin/movies/export',
    tags: [admin],
    summary: 'Export movies as JSON or CSV',
    permissions: [PERMISSIONS.CONTENT_IMPORT],
    query: S.exportQuery,
    rawResponse: { contentType: 'text/csv', description: 'File download (JSON or CSV)' },
    handler: c.export,
  })
  .route({
    method: 'post',
    path: '/admin/movies/import',
    tags: [admin],
    summary: 'Bulk import movies (all-or-nothing, max 200)',
    permissions: [PERMISSIONS.CONTENT_IMPORT],
    body: S.importMoviesBody,
    response: z.object({ imported: z.number().int(), ids: z.array(z.uuid()) }),
    responseStatus: 201,
    errors: [409],
    handler: c.import,
  })
  .route({
    method: 'post',
    path: '/admin/movies',
    tags: [admin],
    summary: 'Create movie (draft)',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    body: S.createMovieBody,
    response: S.adminMovieSchema,
    responseStatus: 201,
    errors: [409],
    handler: c.create,
  })
  .route({
    method: 'get',
    path: '/admin/movies/:id',
    tags: [admin],
    summary: 'Movie details (admin)',
    permissions: [PERMISSIONS.CONTENT_READ],
    params: idParam,
    response: S.adminMovieSchema,
    errors: [404],
    handler: c.adminGet,
  })
  .route({
    method: 'patch',
    path: '/admin/movies/:id',
    tags: [admin],
    summary: 'Update movie',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: S.updateMovieBody,
    response: S.adminMovieSchema,
    errors: [404, 409],
    handler: c.update,
  })
  .route({
    method: 'post',
    path: '/admin/movies/:id/publish',
    tags: [admin],
    summary: 'Publish movie',
    permissions: [PERMISSIONS.CONTENT_PUBLISH],
    params: idParam,
    response: S.adminMovieSchema,
    errors: [404],
    handler: c.status('PUBLISHED'),
  })
  .route({
    method: 'post',
    path: '/admin/movies/:id/unpublish',
    tags: [admin],
    summary: 'Move movie back to draft',
    permissions: [PERMISSIONS.CONTENT_PUBLISH],
    params: idParam,
    response: S.adminMovieSchema,
    errors: [404],
    handler: c.status('DRAFT'),
  })
  .route({
    method: 'post',
    path: '/admin/movies/:id/archive',
    tags: [admin],
    summary: 'Archive movie (hidden from catalog)',
    permissions: [PERMISSIONS.CONTENT_PUBLISH],
    params: idParam,
    response: S.adminMovieSchema,
    errors: [404],
    handler: c.status('ARCHIVED'),
  })
  .route({
    method: 'delete',
    path: '/admin/movies/:id',
    tags: [admin],
    summary: 'Soft-delete movie',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: null,
    errors: [404],
    handler: c.remove,
  })
  .route({
    method: 'post',
    path: '/admin/movies/:id/restore',
    tags: [admin],
    summary: 'Restore a soft-deleted movie (as draft)',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: S.adminMovieSchema,
    errors: [404],
    handler: c.restore,
  })
  .route({
    method: 'put',
    path: '/admin/movies/:id/cast',
    tags: [admin],
    summary: 'Replace cast list',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: S.setCastBody,
    response: S.adminMovieSchema,
    errors: [404],
    handler: c.setCast,
  })
  .route({
    method: 'put',
    path: '/admin/movies/:id/crew',
    tags: [admin],
    summary: 'Replace crew list',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: S.setCrewBody,
    response: S.adminMovieSchema,
    errors: [404],
    handler: c.setCrew,
  });

export const moviesRouter = api.router;
