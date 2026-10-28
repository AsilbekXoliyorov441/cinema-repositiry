import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { sendSuccess } from '../../common/http/response.js';
import type { RouteContext } from '../../common/http/api-router.js';
import type { idParam } from '../../common/utils/schemas.js';
import { clearRefreshCookie } from '../auth/auth.cookies.js';
import { usersService } from './users.service.js';
import type * as S from './users.schemas.js';

type IdParams = z.infer<typeof idParam>;

export const usersController = {
  async me({ res, actor }: RouteContext<undefined, undefined, undefined>) {
    sendSuccess(res, await usersService.getMe(actor().userId));
  },
  async updateMe({ res, actor, body }: RouteContext<undefined, undefined, z.infer<typeof S.updateMeBody>>) {
    sendSuccess(res, await usersService.updateMe(actor().userId, body), { message: 'Profile updated' });
  },
  async uploadAvatar({ req, res, actor }: RouteContext<undefined, undefined, undefined>) {
    if (!req.file) throw AppError.upload('Field "file" is required');
    sendSuccess(res, await usersService.setAvatar(actor().userId, req.file), { message: 'Avatar updated' });
  },
  async removeAvatar({ res, actor }: RouteContext<undefined, undefined, undefined>) {
    await usersService.removeAvatar(actor().userId);
    sendSuccess(res, null, { message: 'Avatar removed' });
  },
  async deleteMe({ res, actor, body, client }: RouteContext<undefined, undefined, z.infer<typeof S.deleteMeBody>>) {
    await usersService.deleteMe(actor(), body.password, client);
    clearRefreshCookie(res);
    sendSuccess(res, null, { message: 'Account deleted' });
  },
  async adminList({ res, query }: RouteContext<undefined, z.infer<typeof S.adminListUsersQuery>, undefined>) {
    const { items, meta } = await usersService.adminList(query);
    sendSuccess(res, items, { meta });
  },
  async adminGet({ res, params }: RouteContext<IdParams, undefined, undefined>) {
    sendSuccess(res, await usersService.adminGet(params.id));
  },
  async ban({ res, params, body, actor, client }: RouteContext<IdParams, undefined, z.infer<typeof S.banBody>>) {
    sendSuccess(res, await usersService.ban(actor(), params.id, body, client), { message: 'User blocked' });
  },
  async unban({ res, params, actor, client }: RouteContext<IdParams, undefined, undefined>) {
    sendSuccess(res, await usersService.unban(actor(), params.id, client), { message: 'User unblocked' });
  },
  async setRoles({ res, params, body, actor, client }: RouteContext<IdParams, undefined, z.infer<typeof S.setRolesBody>>) {
    sendSuccess(res, await usersService.setRoles(actor(), params.id, body.roles, client), { message: 'Roles updated' });
  },
};
