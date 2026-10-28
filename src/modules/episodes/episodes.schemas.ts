import { z } from 'zod';
import { ACCESS_TIER, CONTENT_STATUS } from '../../common/utils/content.js';
import { imageViewSchema } from '../media/media.schemas.js';

export const createEpisodeBody = z.object({
  episodeNumber: z.number().int().min(0).max(5000),
  title: z.string().trim().min(1).max(255),
  overview: z.string().trim().max(10_000).nullable().optional(),
  airDate: z.iso.date().nullable().optional(),
  durationMinutes: z.number().int().min(1).max(1000).nullable().optional(),
  stillImageId: z.uuid().nullable().optional(),
  accessTier: z.enum(ACCESS_TIER).nullable().optional().describe('null = inherit from series'),
  status: z.enum(CONTENT_STATUS).optional(),
});
export const updateEpisodeBody = createEpisodeBody.partial();

export const episodeSchema = z.object({
  id: z.uuid(),
  episodeNumber: z.number().int(),
  title: z.string(),
  overview: z.string().nullable(),
  airDate: z.string().nullable(),
  durationMinutes: z.number().int().nullable(),
  accessTier: z.enum(ACCESS_TIER).describe('Effective tier (inherits from series when not set)'),
  still: imageViewSchema.nullable(),
});

export const adminEpisodeSchema = episodeSchema.extend({
  seasonId: z.uuid(),
  ownAccessTier: z.enum(ACCESS_TIER).nullable(),
  status: z.enum(CONTENT_STATUS),
  publishedAt: z.string().nullable(),
});

export const seasonWithEpisodesSchema = z.object({
  id: z.uuid(),
  seriesId: z.uuid(),
  seasonNumber: z.number().int(),
  title: z.string().nullable(),
  overview: z.string().nullable(),
  airDate: z.string().nullable(),
  poster: imageViewSchema.nullable(),
  episodes: z.array(episodeSchema),
});
