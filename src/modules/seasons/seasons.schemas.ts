import { z } from 'zod';
import { CONTENT_STATUS } from '../../common/utils/content.js';

export const createSeasonBody = z.object({
  seasonNumber: z.number().int().min(0).max(500),
  title: z.string().trim().max(255).nullable().optional(),
  overview: z.string().trim().max(10_000).nullable().optional(),
  airDate: z.iso.date().nullable().optional(),
  posterImageId: z.uuid().nullable().optional(),
  status: z.enum(CONTENT_STATUS).optional(),
});
export const updateSeasonBody = createSeasonBody.partial();

export const seasonParams = z.object({ idOrSlug: z.string().min(1).max(280), seasonNumber: z.coerce.number().int().min(0).max(500) });
