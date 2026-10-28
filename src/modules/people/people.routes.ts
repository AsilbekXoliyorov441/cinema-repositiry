import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { idParam, slugOrIdParam } from '../../common/utils/schemas.js';
import { peopleService } from './people.service.js';
import { listPeopleQuery, personBody, personDetailSchema, personSummarySchema, updatePersonBody } from './people.schemas.js';

const api = new ApiRouter('Catalog · People');
const admin = 'Admin · Catalog';

api
  .route({
    method: 'get',
    path: '/people',
    summary: 'Search people (cast & crew)',
    query: listPeopleQuery,
    response: personSummarySchema,
    paginated: true,
    handler: async ({ res, query }) => {
      const { items, meta } = await peopleService.list(query);
      sendSuccess(res, items, { meta });
    },
  })
  .route({
    method: 'get',
    path: '/people/:idOrSlug',
    summary: 'Person details with filmography',
    params: slugOrIdParam,
    response: personDetailSchema,
    errors: [404],
    handler: async ({ res, params }) => sendSuccess(res, await peopleService.get(params.idOrSlug)),
  })
  .route({
    method: 'post',
    path: '/admin/people',
    tags: [admin],
    summary: 'Create person',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    body: personBody,
    response: personDetailSchema,
    responseStatus: 201,
    errors: [409],
    handler: async ({ res, body, actor, client }) => sendCreated(res, await peopleService.create(body, { userId: actor().userId, client })),
  })
  .route({
    method: 'patch',
    path: '/admin/people/:id',
    tags: [admin],
    summary: 'Update person',
    permissions: [PERMISSIONS.CONTENT_WRITE],
    params: idParam,
    body: updatePersonBody,
    response: personDetailSchema,
    errors: [404, 409],
    handler: async ({ res, params, body, actor, client }) =>
      sendSuccess(res, await peopleService.update(params.id, body, { userId: actor().userId, client })),
  })
  .route({
    method: 'delete',
    path: '/admin/people/:id',
    tags: [admin],
    summary: 'Delete person (soft delete)',
    permissions: [PERMISSIONS.CONTENT_DELETE],
    params: idParam,
    response: null,
    errors: [404],
    handler: async ({ res, params, actor, client }) => {
      await peopleService.remove(params.id, { userId: actor().userId, client });
      sendSuccess(res, null, { message: 'Person deleted' });
    },
  });

export const peopleRouter = api.router;
