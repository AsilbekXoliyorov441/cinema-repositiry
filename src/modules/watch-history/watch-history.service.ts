import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { publicContentWhere } from '../../common/utils/content.js';
import { buildMeta, toSkipTake, type PaginationInput } from '../../common/utils/pagination.js';
import { imageSelect, toImageView } from '../media/media.urls.js';
import { publicEpisodeWhere } from '../episodes/episodes.service.js';
import { evaluateProgress } from './progress.policy.js';

/** Writes closer together than this for the same item are coalesced (client heartbeat protection). */
const MIN_WRITE_INTERVAL_MS = 5_000;

const movieRef = { id: true, title: true, slug: true, durationMinutes: true, backdrop: { select: imageSelect }, poster: { select: imageSelect } } as const;
const episodeRef = {
  id: true,
  title: true,
  episodeNumber: true,
  durationMinutes: true,
  still: { select: imageSelect },
  season: { select: { seasonNumber: true, series: { select: { id: true, slug: true, title: true } } } },
} as const;

type MovieRef = { id: string; title: string; slug: string; backdrop: Parameters<typeof toImageView>[0]; poster: Parameters<typeof toImageView>[0] };
type EpisodeRef = {
  id: string;
  title: string;
  episodeNumber: number;
  still: Parameters<typeof toImageView>[0];
  season: { seasonNumber: number; series: { id: string; slug: string; title: string } };
};

function contentRef(movie: MovieRef | null, episode: EpisodeRef | null) {
  if (movie) {
    return { type: 'movie' as const, id: movie.id, title: movie.title, slug: movie.slug, image: toImageView(movie.backdrop ?? movie.poster), series: null };
  }
  const e = episode as EpisodeRef;
  return {
    type: 'episode' as const,
    id: e.id,
    title: e.title,
    slug: null,
    image: toImageView(e.still),
    series: { ...e.season.series, seasonNumber: e.season.seasonNumber, episodeNumber: e.episodeNumber },
  };
}

function view(p: { positionSeconds: number; durationSeconds: number; completed: boolean; lastWatchedAt: Date }) {
  return { positionSeconds: p.positionSeconds, durationSeconds: p.durationSeconds, completed: p.completed, lastWatchedAt: p.lastWatchedAt.toISOString() };
}

export const watchHistoryService = {
  async saveMovieProgress(userId: string, movieId: string, input: { positionSeconds: number; durationSeconds?: number | undefined }) {
    const movie = await prisma.movie.findFirst({ where: { id: movieId, ...publicContentWhere() }, select: { durationMinutes: true } });
    if (!movie) throw AppError.notFound('Movie');
    return this.save(userId, { movieId }, input, movie.durationMinutes);
  },

  async saveEpisodeProgress(userId: string, episodeId: string, input: { positionSeconds: number; durationSeconds?: number | undefined }) {
    const episode = await prisma.episode.findFirst({ where: { id: episodeId, ...publicEpisodeWhere() }, select: { durationMinutes: true } });
    if (!episode) throw AppError.notFound('Episode');
    return this.save(userId, { episodeId }, input, episode.durationMinutes);
  },

  async save(
    userId: string,
    target: { movieId: string } | { episodeId: string },
    input: { positionSeconds: number; durationSeconds?: number | undefined },
    durationMinutes: number | null,
  ) {
    const decision = evaluateProgress({
      positionSeconds: input.positionSeconds,
      clientDurationSeconds: input.durationSeconds,
      catalogDurationSeconds: durationMinutes ? durationMinutes * 60 : null,
    });
    if (!decision.ok) throw AppError.validation([{ path: 'positionSeconds', message: decision.reason }]);

    const where = 'movieId' in target ? { userId_movieId: { userId, movieId: target.movieId } } : { userId_episodeId: { userId, episodeId: target.episodeId } };
    const existing = await prisma.watchProgress.findUnique({ where });
    const now = new Date();
    if (existing && now.getTime() - existing.updatedAt.getTime() < MIN_WRITE_INTERVAL_MS && existing.completed === decision.completed) {
      return view(existing);
    }
    const data = {
      positionSeconds: decision.positionSeconds,
      durationSeconds: decision.durationSeconds,
      completed: decision.completed,
      completedAt: decision.completed ? (existing?.completedAt ?? now) : null,
      lastWatchedAt: now,
    };
    const saved = await prisma.watchProgress.upsert({ where, create: { userId, ...target, ...data }, update: data });
    return view(saved);
  },

  async getMovieProgress(userId: string, movieId: string) {
    const p = await prisma.watchProgress.findUnique({ where: { userId_movieId: { userId, movieId } } });
    return p ? view(p) : null;
  },

  async continueWatching(userId: string, limit = 20) {
    const rows = await prisma.watchProgress.findMany({
      where: {
        userId,
        completed: false,
        positionSeconds: { gt: 0 },
        OR: [{ movie: { ...publicContentWhere() } }, { episode: publicEpisodeWhere() }],
      },
      orderBy: { lastWatchedAt: 'desc' },
      take: limit,
      include: { movie: { select: movieRef }, episode: { select: episodeRef } },
    });
    return rows.map((r) => ({
      ...view(r),
      percent: Math.round((r.positionSeconds / r.durationSeconds) * 1000) / 10,
      content: contentRef(r.movie, r.episode),
    }));
  },

  async history(userId: string, query: PaginationInput) {
    const where = { userId };
    const [rows, total] = await prisma.$transaction([
      prisma.watchHistory.findMany({
        where,
        orderBy: { lastWatchedAt: 'desc' },
        ...toSkipTake(query),
        include: { movie: { select: movieRef }, episode: { select: episodeRef } },
      }),
      prisma.watchHistory.count({ where }),
    ]);
    const items = rows
      .filter((r) => r.movie || r.episode)
      .map((r) => ({ id: r.id, watchedOn: r.watchedOn.toISOString().slice(0, 10), lastWatchedAt: r.lastWatchedAt.toISOString(), content: contentRef(r.movie, r.episode) }));
    return { items, meta: buildMeta(query, total) };
  },

  async deleteEntry(userId: string, id: string) {
    // userId in the filter enforces ownership; a foreign id behaves like a missing one.
    const r = await prisma.watchHistory.deleteMany({ where: { id, userId } });
    if (r.count === 0) throw AppError.notFound('History entry');
  },

  async clear(userId: string) {
    const [history] = await prisma.$transaction([
      prisma.watchHistory.deleteMany({ where: { userId } }),
      prisma.watchProgress.deleteMany({ where: { userId } }),
    ]);
    return { deleted: history.count };
  },
};
