import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import { idParam } from '../../common/utils/schemas.js';
import { rolesService } from './roles.service.js';
import { createRoleBody, permissionSchema, roleSchema, setPermissionsBody, updateRoleBody } from './roles.schemas.js';

const api = new ApiRouter('Admin · Roles');

api
  .route({
    method: 'get',
    path: '/admin/roles',
    summary: 'List roles with their permissions',
    permissions: [PERMISSIONS.ROLES_READ],
    response: z.array(roleSchema),
    handler: async ({ res }) => sendSuccess(res, await rolesService.list()),
  })
  .route({
    method: 'get',
    path: '/admin/permissions',
    summary: 'List all permissions',
    permissions: [PERMISSIONS.ROLES_READ],
    response: z.array(permissionSchema),
    handler: async ({ res }) => sendSuccess(res, await rolesService.listPermissions()),
  })
  .route({
    method: 'post',
    path: '/admin/roles',
    summary: 'Create a custom role',
    description: 'Level must be below your own; you can only grant permissions you hold.',
    permissions: [PERMISSIONS.ROLES_MANAGE],
    body: createRoleBody,
    response: roleSchema,
    responseStatus: 201,
    errors: [409],
    handler: async ({ res, body, actor, client }) => sendCreated(res, await rolesService.create(actor(), body, client)),
  })
  .route({
    method: 'patch',
    path: '/admin/roles/:id',
    summary: 'Update role description/level',
    permissions: [PERMISSIONS.ROLES_MANAGE],
    params: idParam,
    body: updateRoleBody,
    response: roleSchema,
    errors: [404],
    handler: async ({ res, params, body, actor, client }) => sendSuccess(res, await rolesService.update(actor(), params.id, body, client)),
  })
  .route({
    method: 'put',
    path: '/admin/roles/:id/permissions',
    summary: 'Replace the permissions of a role',
    permissions: [PERMISSIONS.ROLES_MANAGE],
    params: idParam,
    body: setPermissionsBody,
    response: roleSchema,
    errors: [404],
    handler: async ({ res, params, body, actor, client }) =>
      sendSuccess(res, await rolesService.setPermissions(actor(), params.id, body.permissions, client)),
  })
  .route({
    method: 'delete',
    path: '/admin/roles/:id',
    summary: 'Delete a custom role (must be unassigned)',
    permissions: [PERMISSIONS.ROLES_MANAGE],
    params: idParam,
    response: null,
    errors: [404, 409],
    handler: async ({ res, params, actor, client }) => {
      await rolesService.remove(actor(), params.id, client);
      sendSuccess(res, null, { message: 'Role deleted' });
    },
  });

export const rolesRouter = api.router;
