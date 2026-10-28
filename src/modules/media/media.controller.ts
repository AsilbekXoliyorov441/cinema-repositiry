import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import type { RouteContext } from '../../common/http/api-router.js';
import type { idParam } from '../../common/utils/schemas.js';
import { storage } from '../../integrations/storage/index.js';
import type { MediaVariant } from './media.urls.js';
import { mediaService, toMediaView } from './media.service.js';
import type { listMediaQuery, mediaContentQuery, uploadImageBody } from './media.schemas.js';

type IdParams = z.infer<typeof idParam>;

function canReadPrivate(ctx: { auth: RouteContext<unknown, unknown, unknown>['auth'] }): boolean {
  return Boolean(ctx.auth?.permissions.has(PERMISSIONS.MEDIA_READ));
}

export const mediaController = {
  async upload(ctx: RouteContext<undefined, undefined, z.infer<typeof uploadImageBody>>) {
    const file = ctx.req.file;
    if (!file) throw AppError.upload('Field "file" is required');
    const media = await mediaService.uploadImage(file, { ...ctx.body, uploadedById: ctx.actor().userId });
    sendCreated(ctx.res, media, 'Image uploaded');
  },

  async uploadBulk(ctx: RouteContext<undefined, undefined, z.infer<typeof uploadImageBody>>) {
    const files = (ctx.req.files as Express.Multer.File[] | undefined) ?? [];
    const results = await mediaService.uploadMany(files, { ...ctx.body, uploadedById: ctx.actor().userId });
    const failed = results.filter((r) => r.error).length;
    sendSuccess(ctx.res, results, {
      status: failed === results.length ? 400 : 201,
      message: `${results.length - failed} uploaded, ${failed} failed`,
    });
  },

  async getPublic(ctx: RouteContext<IdParams, undefined, undefined>) {
    const media = await mediaService.getById(ctx.params.id);
    if (media.visibility === 'PRIVATE' && !canReadPrivate(ctx)) throw AppError.notFound('Media');
    const view = toMediaView(media);
    sendSuccess(ctx.res, {
      id: view.id,
      kind: view.kind,
      url: view.url,
      width: view.width,
      height: view.height,
      mimeType: view.mimeType,
      altText: view.altText,
      variants: view.variants,
    });
  },

  async content(ctx: RouteContext<IdParams, z.infer<typeof mediaContentQuery>, undefined>) {
    const media = await mediaService.getById(ctx.params.id);
    if (media.visibility === 'PRIVATE' && !canReadPrivate(ctx)) throw AppError.notFound('Media');
    let key = media.storageKey;
    let mime = media.mimeType;
    if (ctx.query.variant) {
      const v = ((media.variants ?? {}) as unknown as Record<string, MediaVariant>)[ctx.query.variant];
      if (!v) throw AppError.notFound('Variant');
      key = v.key;
      mime = 'image/webp';
    }
    const stream = await storage.getStream(key).catch(() => {
      throw AppError.notFound('Media file');
    });
    ctx.res.setHeader('Content-Type', mime);
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
    ctx.res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    ctx.res.setHeader('Cache-Control', media.visibility === 'PUBLIC' ? 'public, max-age=31536000, immutable' : 'private, no-store');
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(ctx.res);
    });
  },

  async adminList(ctx: RouteContext<undefined, z.infer<typeof listMediaQuery>, undefined>) {
    const { items, meta } = await mediaService.list(ctx.query);
    sendSuccess(ctx.res, items, { meta });
  },

  async adminGet(ctx: RouteContext<IdParams, undefined, undefined>) {
    const media = await mediaService.getById(ctx.params.id);
    sendSuccess(ctx.res, { ...toMediaView(media), references: await mediaService.references(media.id) });
  },

  async adminDelete(ctx: RouteContext<IdParams, undefined, undefined>) {
    await mediaService.delete(ctx.params.id, { userId: ctx.actor().userId, client: ctx.client });
    sendSuccess(ctx.res, null, { message: 'Media deleted' });
  },
};
