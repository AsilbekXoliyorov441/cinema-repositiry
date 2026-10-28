import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { rateLimiters } from '../../common/middleware/rate-limit.js';
import { idParam } from '../../common/utils/schemas.js';
import { singleImage } from '../media/upload.middleware.js';
import { userProfileSchema } from './users.mapper.js';
import { usersController as c } from './users.controller.js';
import * as S from './users.schemas.js';

const api = new ApiRouter('Me · Profile');
const admin = 'Admin · Users';

api
  .route({ method: 'get', path: '/me', summary: 'My profile', auth: 'user', response: userProfileSchema, handler: c.me })
  .route({
    method: 'patch',
    path: '/me',
    summary: 'Update my profile',
    auth: 'user',
    body: S.updateMeBody,
    response: userProfileSchema,
    handler: c.updateMe,
  })
  .route({
    method: 'post',
    path: '/me/avatar',
    summary: 'Upload my avatar',
    auth: 'user',
    rateLimit: rateLimiters.upload,
    before: [singleImage],
    multipartSchema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
    response: userProfileSchema,
    errors: [400, 413, 415],
    handler: c.uploadAvatar,
  })
  .route({ method: 'delete', path: '/me/avatar', summary: 'Remove my avatar', auth: 'user', response: null, handler: c.removeAvatar })
  .route({
    method: 'delete',
    path: '/me',
    summary: 'Delete (anonymize) my account',
    description: 'Payment and audit history is retained in anonymized form.',
    auth: 'user',
    body: S.deleteMeBody,
    response: null,
    errors: [400, 409],
    handler: c.deleteMe,
  })
  .route({
    method: 'get',
    path: '/admin/users',
    tags: [admin],
    summary: 'Search users',
    permissions: [PERMISSIONS.USERS_READ],
    query: S.adminListUsersQuery,
    response: S.adminUserSchema,
    paginated: true,
    handler: c.adminList,
  })
  .route({
    method: 'get',
    path: '/admin/users/:id',
    tags: [admin],
    summary: 'User details',
    permissions: [PERMISSIONS.USERS_READ],
    params: idParam,
    response: S.adminUserSchema,
    errors: [404],
    handler: c.adminGet,
  })
  .route({
    method: 'post',
    path: '/admin/users/:id/ban',
    tags: [admin],
    summary: 'Block a user',
    description: 'Revokes all sessions immediately. You cannot block yourself, protected accounts, or users at/above your level.',
    permissions: [PERMISSIONS.USERS_MANAGE],
    params: idParam,
    body: S.banBody,
    response: S.adminUserSchema,
    errors: [404],
    handler: c.ban,
  })
  .route({
    method: 'post',
    path: '/admin/users/:id/unban',
    tags: [admin],
    summary: 'Unblock a user',
    permissions: [PERMISSIONS.USERS_MANAGE],
    params: idParam,
    response: S.adminUserSchema,
    errors: [404, 409],
    handler: c.unban,
  })
  .route({
    method: 'put',
    path: '/admin/users/:id/roles',
    tags: [admin],
    summary: "Replace a user's roles",
    description: 'Only roles below your level can be granted. USER is always kept. The target is signed out.',
    permissions: [PERMISSIONS.USERS_ASSIGN_ROLES],
    params: idParam,
    body: S.setRolesBody,
    response: S.adminUserSchema,
    errors: [404],
    handler: c.setRoles,
  });

export const usersRouter = api.router;
