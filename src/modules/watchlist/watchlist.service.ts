import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { buildMeta, toSkipTake } from '../../common/utils/pagination.js';
import { imageSelect, toImageView } from '../media/media.urls.js';
import { toMovieSummary } from '../movies/movies.mapper.js';
import { movieSummarySelect } from '../movies/movies.repository.js';
import { publicContentWhere } from '../../common/utils/content.js';
import { publicSeriesWhere } from '../series/series.service.js';
import type { z } from 'zod';
import type { watchlistQuery } from './watchlist.schemas.js';

export const watchlistService = {
  async list(userId: string, query: z.infer<typeof watchlistQuery>) {
    const where: Prisma.WatchlistItemWhereInput = {
      userId,
      // Items whose content was unpublished/deleted are hidden rather than exposing drafts.
      OR: [
        ...(query.type !== 'series' ? [{ movie: { ...publicContentWhere(), visibility: { in: ['PUBLIC', 'UNLISTED'] as ('PUBLIC' | 'UNLISTED')[] } } }] : []),
        ...(query.type !== 'movie' ? [{ series: publicSeriesWhere() }] : []),
      ],
    };
    const [rows, total] = await prisma.$transaction([
      prisma.watchlistItem.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(query),
        include: {
          movie: { select: movieSummarySelect },
          series: { select: { id: true, slug: true, title: true, accessTier: true, poster: { select: imageSelect } } },
        },
      }),
      prisma.watchlistItem.count({ where }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      type: r.movieId ? ('movie' as const) : ('series' as const),
      addedAt: r.createdAt.toISOString(),
      movie: r.movie ? toMovieSummary(r.movie) : null,
      series: r.series ? { ...r.series, poster: toImageView(r.series.poster) } : null,
    }));
    return { items, meta: buildMeta(query, total) };
  },

  async add(userId: string, target: { movieId?: string | undefined; seriesId?: string | undefined }) {
    if (target.movieId) {
      const movie = await prisma.movie.findFirst({ where: { id: target.movieId, ...publicContentWhere() }, select: { id: true } });
      if (!movie) throw AppError.notFound('Movie');
    } else if (target.seriesId) {
      const series = await prisma.series.findFirst({ where: { id: target.seriesId, ...publicSeriesWhere() }, select: { id: true } });
      if (!series) throw AppError.notFound('Series');
    }
    // The unique (userId, movieId)/(userId, seriesId) constraint rejects duplicates atomically → 409.
    const item = await prisma.watchlistItem.create({ data: { userId, movieId: target.movieId ?? null, seriesId: target.seriesId ?? null } });
    return { id: item.id, addedAt: item.createdAt.toISOString() };
  },

  async remove(userId: string, type: 'movies' | 'series', id: string) {
    const r = await prisma.watchlistItem.deleteMany({ where: { userId, ...(type === 'movies' ? { movieId: id } : { seriesId: id }) } });
    if (r.count === 0) throw AppError.notFound('Watchlist item');
  },
};
