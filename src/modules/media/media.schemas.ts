import { z } from 'zod';
import { paginationQuery } from '../../common/utils/pagination.js';

export const imageViewSchema = z.object({
  id: z.uuid(),
  url: z.url(),
  width: z.number().int(),
  height: z.number().int(),
  alt: z.string().nullable(),
  variants: z.record(z.string(), z.object({ url: z.string(), width: z.number(), height: z.number() })),
});

export const MEDIA_KINDS = [
  'POSTER',
  'BACKDROP',
  'PERSON_PHOTO',
  'SERIES_IMAGE',
  'EPISODE_STILL',
  'AVATAR',
  'COLLECTION_COVER',
  'OTHER',
] as const;

export const uploadImageBody = z.object({
  kind: z.enum(MEDIA_KINDS).default('OTHER'),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
  altText: z.string().trim().max(300).optional(),
});

export const listMediaQuery = paginationQuery.extend({
  kind: z.enum(MEDIA_KINDS).optional(),
  orphaned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const mediaContentQuery = z.object({
  variant: z.string().regex(/^[a-z]+$/).max(20).optional(),
});

export const mediaAssetSchema = z.object({
  id: z.uuid(),
  kind: z.enum(MEDIA_KINDS),
  visibility: z.enum(['PUBLIC', 'PRIVATE']),
  storageProvider: z.string(),
  url: z.string(),
  originalName: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  checksum: z.string(),
  altText: z.string().nullable(),
  variants: imageViewSchema.shape.variants,
  uploadedById: z.uuid().nullable(),
  orphanedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MediaAssetView = z.infer<typeof mediaAssetSchema>;

export const mediaReferenceSchema = z.object({ type: z.string(), id: z.string(), label: z.string() });
