import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { PERMISSIONS } from '../../common/constants/permissions.js';
import { rateLimiters } from '../../common/middleware/rate-limit.js';
import { idParam } from '../../common/utils/schemas.js';
import { mediaController as c } from './media.controller.js';
import { listMediaQuery, mediaAssetSchema, mediaContentQuery, mediaReferenceSchema, uploadImageBody } from './media.schemas.js';
import { multipleImages, multipleImagesDoc, singleImage, singleImageDoc } from './upload.middleware.js';

const api = new ApiRouter('Media');
const admin = 'Admin · Media';

api
  .route({
    method: 'post',
    path: '/admin/media/images',
    tags: [admin],
    summary: 'Upload an image',
    description: 'Validates real file format (magic bytes + full decode), strips EXIF/metadata, stores under a random UUID name and creates WebP variants.',
    permissions: [PERMISSIONS.MEDIA_UPLOAD],
    rateLimit: rateLimiters.upload,
    before: [singleImage],
    body: uploadImageBody,
    multipartSchema: singleImageDoc,
    response: mediaAssetSchema,
    responseStatus: 201,
    errors: [400, 413, 415],
    handler: c.upload,
  })
  .route({
    method: 'post',
    path: '/admin/media/images/bulk',
    tags: [admin],
    summary: 'Upload several images at once',
    description: 'Each file is processed independently; the response lists per-file results.',
    permissions: [PERMISSIONS.MEDIA_UPLOAD],
    rateLimit: rateLimiters.upload,
    before: [multipleImages],
    body: uploadImageBody.omit({ altText: true }),
    multipartSchema: multipleImagesDoc,
    response: z.array(z.object({ originalName: z.string().nullable(), media: mediaAssetSchema.optional(), error: z.string().optional() })),
    responseStatus: 201,
    errors: [400, 413, 415],
    handler: c.uploadBulk,
  })
  .route({
    method: 'get',
    path: '/media/:id',
    summary: 'Public media metadata and URLs',
    description: 'Private media is visible only to staff with `media:read`.',
    auth: 'optional',
    params: idParam,
    response: mediaAssetSchema.pick({ id: true, kind: true, url: true, width: true, height: true, mimeType: true, altText: true, variants: true }),
    errors: [404],
    handler: c.getPublic,
  })
  .route({
    method: 'get',
    path: '/media/:id/content',
    summary: 'Stream the media file (used for private media)',
    auth: 'optional',
    params: idParam,
    query: mediaContentQuery,
    rawResponse: { contentType: 'image/*', description: 'Image bytes' },
    errors: [404],
    handler: c.content,
  })
  .route({
    method: 'get',
    path: '/admin/media',
    tags: [admin],
    summary: 'Browse the media library',
    permissions: [PERMISSIONS.MEDIA_READ],
    query: listMediaQuery,
    response: mediaAssetSchema,
    paginated: true,
    handler: c.adminList,
  })
  .route({
    method: 'get',
    path: '/admin/media/:id',
    tags: [admin],
    summary: 'Media details including where it is used',
    permissions: [PERMISSIONS.MEDIA_READ],
    params: idParam,
    response: mediaAssetSchema.extend({ references: z.array(mediaReferenceSchema) }),
    errors: [404],
    handler: c.adminGet,
  })
  .route({
    method: 'delete',
    path: '/admin/media/:id',
    tags: [admin],
    summary: 'Delete a media file',
    description: 'Returns 409 with the list of references while the file is still used (e.g. as a movie poster).',
    permissions: [PERMISSIONS.MEDIA_DELETE],
    params: idParam,
    response: null,
    errors: [404, 409],
    handler: c.adminDelete,
  });

export const mediaRouter = api.router;
