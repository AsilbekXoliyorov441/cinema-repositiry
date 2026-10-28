import { z } from 'zod';
import { ACCESS_TIER, AGE_RATING, CONTENT_STATUS, VISIBILITY, externalIdsSchema, genreRefSchema, slugInput } from '../../common/utils/content.js';
import { paginationQuery, sortQuery } from '../../common/utils/pagination.js';
import { searchTerm } from '../../common/utils/search.js';
import { countryCode, languageCode } from '../../common/utils/schemas.js';
import { trailerUrl } from '../../common/utils/url-safety.js';
import { imageViewSchema } from '../media/media.schemas.js';

export const listSeriesQuery = paginationQuery.extend({
  q: searchTerm,
  genre: z.string().max(100).optional(),
  accessTier: z.enum(ACCESS_TIER).optional(),
  sort: sortQuery(['publishedAt', 'firstAirDate', 'title'], '-publishedAt'),
});

export const adminListSeriesQuery = paginationQuery.extend({
  q: searchTerm,
  status: z.enum(CONTENT_STATUS).optional(),
  sort: sortQuery(['createdAt', 'title', 'publishedAt'], '-createdAt'),
});

const fields = {
  title: z.string().trim().min(1).max(255),
  originalTitle: z.string().trim().max(255).nullable().optional(),
  slug: slugInput.optional(),
  overview: z.string().trim().max(10_000).nullable().optional(),
  firstAirDate: z.iso.date().nullable().optional(),
  lastAirDate: z.iso.date().nullable().optional(),
  ageRating: z.enum(AGE_RATING).optional(),
  language: languageCode.nullable().optional(),
  country: countryCode.nullable().optional(),
  visibility: z.enum(VISIBILITY).optional(),
  accessTier: z.enum(ACCESS_TIER).optional(),
  featured: z.boolean().optional(),
  posterImageId: z.uuid().nullable().optional(),
  backdropImageId: z.uuid().nullable().optional(),
  trailerUrl: trailerUrl.nullable().optional(),
  seoTitle: z.string().trim().max(255).nullable().optional(),
  seoDescription: z.string().trim().max(500).nullable().optional(),
  externalIds: externalIdsSchema.nullable().optional(),
  genreIds: z.array(z.uuid()).max(20).optional(),
};
export const createSeriesBody = z.object(fields);
export const updateSeriesBody = z.object(fields).partial();
export type UpdateSeriesInput = z.infer<typeof updateSeriesBody>;

export const seriesSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  originalTitle: z.string().nullable(),
  firstAirDate: z.string().nullable(),
  ageRating: z.enum(AGE_RATING),
  accessTier: z.enum(ACCESS_TIER),
  featured: z.boolean(),
  poster: imageViewSchema.nullable(),
  backdrop: imageViewSchema.nullable(),
  genres: z.array(genreRefSchema),
  seasonCount: z.number().int(),
});

export const seasonSummarySchema = z.object({
  id: z.uuid(),
  seasonNumber: z.number().int(),
  title: z.string().nullable(),
  airDate: z.string().nullable(),
  poster: imageViewSchema.nullable(),
  episodeCount: z.number().int(),
});

export const seriesDetailSchema = seriesSummarySchema.extend({
  overview: z.string().nullable(),
  lastAirDate: z.string().nullable(),
  language: z.string().nullable(),
  country: z.string().nullable(),
  trailerUrl: z.string().nullable(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  seasons: z.array(seasonSummarySchema),
});

export const adminSeriesSchema = seriesDetailSchema.extend({
  status: z.enum(CONTENT_STATUS),
  visibility: z.enum(VISIBILITY),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
