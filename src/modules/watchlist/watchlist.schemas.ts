import { z } from 'zod';
import { paginationQuery } from '../../common/utils/pagination.js';
import { movieSummarySchema } from '../movies/movies.schemas.js';
import { seriesSummarySchema } from '../series/series.schemas.js';

export const addWatchlistBody = z
  .object({ movieId: z.uuid().optional(), seriesId: z.uuid().optional() })
  .refine((v) => Boolean(v.movieId) !== Boolean(v.seriesId), 'Provide exactly one of movieId or seriesId');

export const watchlistQuery = paginationQuery.extend({ type: z.enum(['movie', 'series']).optional() });
export const watchlistTargetParams = z.object({ type: z.enum(['movies', 'series']), id: z.uuid() });

export const watchlistItemSchema = z.object({
  id: z.uuid(),
  type: z.enum(['movie', 'series']),
  addedAt: z.string(),
  movie: movieSummarySchema.omit({}).nullable(),
  series: seriesSummarySchema.pick({ id: true, slug: true, title: true, poster: true, accessTier: true }).nullable(),
});
