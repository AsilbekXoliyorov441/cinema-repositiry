import { z } from 'zod';
import { paginationQuery } from '../../common/utils/pagination.js';
import { imageViewSchema } from '../media/media.schemas.js';

export const progressBody = z.object({
  positionSeconds: z.number().int().min(0).max(86_400),
  // Only a hint: ignored when the catalog has a runtime, otherwise bounded by evaluateProgress().
  durationSeconds: z.number().int().min(1).max(2_147_483_647).optional().describe('Used only when the catalog has no runtime'),
});

export const progressSchema = z.object({
  positionSeconds: z.number().int(),
  durationSeconds: z.number().int(),
  completed: z.boolean(),
  lastWatchedAt: z.string(),
});

export const historyQuery = paginationQuery;

const contentRef = z.object({
  type: z.enum(['movie', 'episode']),
  id: z.uuid(),
  title: z.string(),
  slug: z.string().nullable(),
  image: imageViewSchema.nullable(),
  series: z.object({ id: z.uuid(), slug: z.string(), title: z.string(), seasonNumber: z.number().int(), episodeNumber: z.number().int() }).nullable(),
});

export const continueWatchingSchema = progressSchema.extend({ content: contentRef, percent: z.number() });
export const historyEntrySchema = z.object({ id: z.uuid(), watchedOn: z.string(), lastWatchedAt: z.string(), content: contentRef });
