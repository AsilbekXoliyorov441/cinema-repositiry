import { z } from 'zod';
import {
  ACCESS_TIER,
  AGE_RATING,
  CONTENT_STATUS,
  CREW_JOB,
  VISIBILITY,
  externalIdsSchema,
  genreRefSchema,
  slugInput,
} from '../../common/utils/content.js';
import { paginationQuery, sortQuery } from '../../common/utils/pagination.js';
import { searchTerm } from '../../common/utils/search.js';
import { booleanQuery, countryCode, csvQuery, languageCode } from '../../common/utils/schemas.js';
import { trailerUrl } from '../../common/utils/url-safety.js';
import { imageViewSchema } from '../media/media.schemas.js';

const year = z.coerce.number().int().min(1888).max(2100);

export const listMoviesQuery = paginationQuery.extend({
  q: searchTerm.describe('Title search (min 2 chars)'),
  genre: z.string().max(100).optional().describe('Genre slug'),
  year: year.optional(),
  yearFrom: year.optional(),
  yearTo: year.optional(),
  country: countryCode.optional(),
  language: languageCode.optional(),
  ageRating: csvQuery.pipe(z.array(z.enum(AGE_RATING)).max(5).optional()).describe('Comma separated, e.g. ALL,AGE_12'),
  accessTier: z.enum(ACCESS_TIER).optional(),
  sort: sortQuery(['publishedAt', 'releaseDate', 'title', 'rating', 'popularity'], '-publishedAt'),
});
export type ListMoviesQuery = z.infer<typeof listMoviesQuery>;

export const shelfQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

export const adminListMoviesQuery = paginationQuery.extend({
  q: searchTerm,
  status: z.enum(CONTENT_STATUS).optional(),
  accessTier: z.enum(ACCESS_TIER).optional(),
  deleted: booleanQuery.describe('true = only soft-deleted movies'),
  sort: sortQuery(['createdAt', 'updatedAt', 'title', 'publishedAt'], '-createdAt'),
});

const movieFields = {
  title: z.string().trim().min(1).max(255),
  originalTitle: z.string().trim().max(255).nullable().optional(),
  slug: slugInput.optional(),
  overview: z.string().trim().max(10_000).nullable().optional(),
  releaseDate: z.iso.date().nullable().optional(),
  durationMinutes: z.number().int().min(1).max(1000).nullable().optional(),
  ageRating: z.enum(AGE_RATING).optional(),
  language: languageCode.nullable().optional(),
  originalLanguage: languageCode.nullable().optional(),
  country: countryCode.nullable().optional(),
  visibility: z.enum(VISIBILITY).optional(),
  accessTier: z.enum(ACCESS_TIER).optional(),
  featured: z.boolean().optional(),
  posterImageId: z.uuid().nullable().optional(),
  backdropImageId: z.uuid().nullable().optional(),
  trailerUrl: trailerUrl.nullable().optional(),
  seoTitle: z.string().trim().max(255).nullable().optional(),
  seoDescription: z.string().trim().max(500).nullable().optional(),
  subtitleLanguages: z.array(languageCode).max(50).optional(),
  externalIds: externalIdsSchema.nullable().optional(),
  genreIds: z.array(z.uuid()).max(20).optional(),
};

export const createMovieBody = z.object(movieFields);
export type CreateMovieInput = z.infer<typeof createMovieBody>;
export const updateMovieBody = z.object(movieFields).partial();
export type UpdateMovieInput = z.infer<typeof updateMovieBody>;

export const setCastBody = z.object({
  cast: z
    .array(z.object({ personId: z.uuid(), characterName: z.string().trim().max(200).nullable().optional(), order: z.number().int().min(0).max(1000).default(0) }))
    .max(200),
});
export const setCrewBody = z.object({
  crew: z.array(z.object({ personId: z.uuid(), job: z.enum(CREW_JOB), jobTitle: z.string().trim().max(100).nullable().optional() })).max(200),
});

export const importMoviesBody = z.object({
  movies: z
    .array(createMovieBody.omit({ genreIds: true, posterImageId: true, backdropImageId: true }).extend({ genres: z.array(z.string().max(100)).max(20).optional().describe('Genre slugs') }))
    .min(1)
    .max(200),
  publish: z.boolean().default(false),
});

export const exportQuery = z.object({ format: z.enum(['json', 'csv']).default('json'), status: z.enum(CONTENT_STATUS).optional() });

// ───── Responses ─────

export const movieSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  originalTitle: z.string().nullable(),
  releaseYear: z.number().int().nullable(),
  durationMinutes: z.number().int().nullable(),
  ageRating: z.enum(AGE_RATING),
  accessTier: z.enum(ACCESS_TIER),
  language: z.string().nullable(),
  country: z.string().nullable(),
  featured: z.boolean(),
  poster: imageViewSchema.nullable(),
  backdrop: imageViewSchema.nullable(),
  genres: z.array(genreRefSchema),
  rating: z.object({ average: z.number(), count: z.number().int() }),
});
export type MovieSummary = z.infer<typeof movieSummarySchema>;

const personCredit = z.object({ id: z.uuid(), name: z.string(), slug: z.string(), photo: imageViewSchema.nullable() });

export const movieDetailSchema = movieSummarySchema.extend({
  overview: z.string().nullable(),
  releaseDate: z.string().nullable(),
  originalLanguage: z.string().nullable(),
  trailerUrl: z.string().nullable(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  subtitleLanguages: z.array(z.string()),
  publishedAt: z.string().nullable(),
  cast: z.array(personCredit.extend({ characterName: z.string().nullable(), order: z.number().int() })),
  crew: z.array(personCredit.extend({ job: z.string(), jobTitle: z.string().nullable() })),
  availableQualities: z.array(z.string()).describe('Quality labels of active feature videos (no URLs — use the playback endpoint)'),
  viewer: z
    .object({
      inWatchlist: z.boolean(),
      myRating: z.number().int().nullable(),
      progress: z.object({ positionSeconds: z.number().int(), durationSeconds: z.number().int(), completed: z.boolean() }).nullable(),
    })
    .nullable()
    .describe('Present only for authenticated requests'),
});

export const adminMovieSchema = movieDetailSchema.omit({ viewer: true }).extend({
  status: z.enum(CONTENT_STATUS),
  visibility: z.enum(VISIBILITY),
  externalIds: z.record(z.string(), z.string()).nullable(),
  viewCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
