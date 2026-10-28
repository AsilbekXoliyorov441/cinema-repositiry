import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { idParam } from '../../common/utils/schemas.js';
import { genresService } from './genres.service.js';
import { genreBody, genreSchema, updateGenreBody } from './genres.schemas.js';

const api = new ApiRouter('Catalog · Genres');
const admin = 'Admin · Catalog';

api
  .route({
    method: 'get',
    path: '/genres',
    summary: 'List genres with public movie counts',
    response: z.array(genreSchema),
    handler: async ({ res }) => sendSuccess(res, await genresService.listPublic()),
  })
  .route({
    method: 'post',
    path: '/admin/genres',
    tags: [admin],
    summary: 'Create genre',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    body: genreBody,
    response: genreSchema,
    responseStatus: 201,
    errors: [409],
    handler: async ({ res, body, actor, client }) => sendCreated(res, await genresService.create(body, { userId: actor().userId, client })),
  })
  .route({
    method: 'patch',
    path: '/admin/genres/:id',
    tags: [admin],
    summary: 'Update genre',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: updateGenreBody,
    response: genreSchema,
    errors: [404, 409],
    handler: async ({ res, params, body, actor, client }) =>
      sendSuccess(res, await genresService.update(params.id, body, { userId: actor().userId, client })),
  })
  .route({
    method: 'delete',
    path: '/admin/genres/:id',
    tags: [admin],
    summary: 'Delete genre (detaches it from movies/series)',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: null,
    errors: [404],
    handler: async ({ res, params, actor, client }) => {
      await genresService.remove(params.id, { userId: actor().userId, client });
      sendSuccess(res, null, { message: 'Genre deleted' });
    },
  });

export const genresRouter = api.router;
