import { prisma, type Tx } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { publicContentWhere } from '../../common/utils/content.js';

/**
 * Recomputes aggregates from the ratings table (never incremental), inside the same transaction
 * that changed the rating. The movie row is locked first (SELECT … FOR UPDATE) so concurrent
 * rating changes for the same movie serialize and every recompute sees all committed ratings.
 */
async function lockMovie(tx: Tx, movieId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM movies WHERE id = ${movieId}::uuid FOR UPDATE`;
}

async function recompute(tx: Tx, movieId: string) {
  const agg = await tx.rating.aggregate({ where: { movieId }, _count: { _all: true }, _sum: { score: true } });
  const count = agg._count._all;
  const sum = agg._sum.score ?? 0;
  return tx.movie.update({
    where: { id: movieId },
    data: { ratingCount: count, ratingSum: sum, ratingAvg: count ? sum / count : 0 },
    select: { ratingCount: true, ratingAvg: true },
  });
}

function view(stats: { ratingCount: number; ratingAvg: number }, myRating: number | null) {
  return { myRating, average: Math.round(stats.ratingAvg * 10) / 10, count: stats.ratingCount };
}

export const ratingsService = {
  async rate(userId: string, movieId: string, score: number) {
    const movie = await prisma.movie.findFirst({ where: { id: movieId, ...publicContentWhere() }, select: { id: true } });
    if (!movie) throw AppError.notFound('Movie');
    const stats = await prisma.$transaction(async (tx) => {
      await lockMovie(tx, movieId);
      await tx.rating.upsert({
        where: { userId_movieId: { userId, movieId } },
        create: { userId, movieId, score },
        update: { score },
      });
      return recompute(tx, movieId);
    });
    await cache.invalidate(CacheNamespace.CATALOG);
    return view(stats, score);
  },

  async remove(userId: string, movieId: string) {
    const stats = await prisma.$transaction(async (tx) => {
      await lockMovie(tx, movieId);
      const r = await tx.rating.deleteMany({ where: { userId, movieId } });
      if (r.count === 0) throw AppError.notFound('Rating');
      return recompute(tx, movieId);
    });
    await cache.invalidate(CacheNamespace.CATALOG);
    return view(stats, null);
  },
};
