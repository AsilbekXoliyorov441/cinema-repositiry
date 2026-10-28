import { z } from 'zod';
import { CONTENT_STATUS, slugInput } from '../../common/utils/content.js';
import { imageViewSchema } from '../media/media.schemas.js';
import { movieSummarySchema } from '../movies/movies.schemas.js';

export const collectionBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugInput.optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  coverMediaId: z.uuid().nullable().optional(),
  status: z.enum(CONTENT_STATUS).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export const updateCollectionBody = collectionBody.partial();
export const setCollectionMoviesBody = z.object({ movieIds: z.array(z.uuid()).max(500) });

export const collectionSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  cover: imageViewSchema.nullable(),
  movieCount: z.number().int(),
});
export const collectionDetailSchema = collectionSummarySchema.extend({ movies: z.array(movieSummarySchema) });
export const adminCollectionSchema = collectionDetailSchema.extend({ status: z.enum(CONTENT_STATUS), sortOrder: z.number().int() });
