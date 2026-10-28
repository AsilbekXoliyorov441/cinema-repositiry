import { containsInsensitive } from '../../common/utils/search.js';
import { Prisma, type ContentStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { buildMeta, toSkipTake } from '../../common/utils/pagination.js';
import { uniqueSlug } from '../../common/utils/slug.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { mediaService } from '../media/media.service.js';
import { toAdminMovie, toMovieDetail, toMovieSummary } from './movies.mapper.js';
import {
  buildPublicWhere,
  movieDetailInclude,
  movieOrderBy,
  moviesRepository,
  publicListWhere,
} from './movies.repository.js';
import type { z } from 'zod';
import type {
  CreateMovieInput,
  ListMoviesQuery,
  UpdateMovieInput,
  adminListMoviesQuery,
  importMoviesBody,
  setCastBody,
  setCrewBody,
} from './movies.schemas.js';

type Actor = { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } };

const CATALOG_TTL = 120;
const TOP_RATED_MIN_VOTES = 3;

function toMovieData(input: UpdateMovieInput): Prisma.MovieUncheckedUpdateInput {
  const releaseDate = input.releaseDate === undefined ? undefined : input.releaseDate === null ? null : new Date(input.releaseDate);
  return {
    title: input.title,
    originalTitle: input.originalTitle,
    overview: input.overview,
    releaseDate,
    releaseYear: releaseDate === undefined ? undefined : releaseDate === null ? null : releaseDate.getUTCFullYear(),
    durationMinutes: input.durationMinutes,
    ageRating: input.ageRating,
    language: input.language,
    originalLanguage: input.originalLanguage,
    country: input.country,
    visibility: input.visibility,
    accessTier: input.accessTier,
    featured: input.featured,
    posterImageId: input.posterImageId,
    backdropImageId: input.backdropImageId,
    trailerUrl: input.trailerUrl,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
    subtitleLanguages: input.subtitleLanguages,
    externalIds: input.externalIds === null ? Prisma.DbNull : input.externalIds,
  };
}

async function assertGenres(ids: string[] | undefined): Promise<void> {
  if (!ids?.length) return;
  const count = await prisma.genre.count({ where: { id: { in: ids } } });
  if (count !== new Set(ids).size) throw AppError.validation([{ path: 'genreIds', message: 'One or more genres do not exist' }]);
}

async function invalidateCatalog(): Promise<void> {
  await cache.invalidate(CacheNamespace.CATALOG, CacheNamespace.GENRES);
}

function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const moviesService = {
  // ───────────── Public catalog ─────────────

  async list(query: ListMoviesQuery) {
    return cache.wrap(CacheNamespace.CATALOG, ['movies.list', query], CATALOG_TTL, async () => {
      const { skip, take } = toSkipTake(query);
      const { rows, total } = await moviesRepository.findPage(buildPublicWhere(query), movieOrderBy(query.sort), skip, take);
      return { items: rows.map(toMovieSummary), meta: buildMeta(query, total) };
    });
  },

  shelf(kind: 'popular' | 'trending' | 'new' | 'top-rated' | 'featured', limit: number) {
    return cache.wrap(CacheNamespace.CATALOG, ['movies.shelf', kind, limit], CATALOG_TTL, async () => {
      const base = publicListWhere();
      const configs: Record<typeof kind, { where: Prisma.MovieWhereInput; orderBy: Prisma.MovieOrderByWithRelationInput[] }> = {
        popular: { where: base, orderBy: [{ popularityScore: 'desc' }, { viewCount: 'desc' }, { id: 'asc' }] },
        trending: { where: base, orderBy: [{ trendingScore: 'desc' }, { publishedAt: 'desc' }, { id: 'asc' }] },
        new: { where: base, orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }] },
        'top-rated': {
          where: { ...base, ratingCount: { gte: TOP_RATED_MIN_VOTES } },
          orderBy: [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }, { id: 'asc' }],
        },
        featured: { where: { ...base, featured: true }, orderBy: [{ popularityScore: 'desc' }, { id: 'asc' }] },
      };
      const { where, orderBy } = configs[kind];
      return (await moviesRepository.findMany(where, orderBy, limit)).map(toMovieSummary);
    });
  },

  async byGenre(slug: string, query: ListMoviesQuery) {
    const genre = await prisma.genre.findUnique({ where: { slug }, select: { id: true } });
    if (!genre) throw AppError.notFound('Genre');
    return this.list({ ...query, genre: slug });
  },

  /**
   * Personalized recommendations: genres the user rated ≥7, watched or saved, weighted by frequency;
   * returns unseen published movies from those genres. Falls back to featured/popular.
   */
  async recommended(userId: string | undefined, limit: number) {
    if (!userId) return this.shelf('featured', limit).then((f) => (f.length ? f : this.shelf('popular', limit)));

    const [rated, watched, saved] = await Promise.all([
      prisma.rating.findMany({ where: { userId, score: { gte: 7 } }, select: { movieId: true }, take: 100 }),
      prisma.watchProgress.findMany({ where: { userId, movieId: { not: null } }, select: { movieId: true }, take: 100 }),
      prisma.watchlistItem.findMany({ where: { userId, movieId: { not: null } }, select: { movieId: true }, take: 100 }),
    ]);
    const seedIds = [...new Set([...rated, ...watched, ...saved].map((r) => r.movieId).filter((id): id is string => Boolean(id)))];
    if (!seedIds.length) return this.shelf('popular', limit);

    const genreCounts = await prisma.movieGenre.groupBy({
      by: ['genreId'],
      where: { movieId: { in: seedIds } },
      _count: { genreId: true },
      orderBy: { _count: { genreId: 'desc' } },
      take: 5,
    });
    const genreIds = genreCounts.map((g) => g.genreId);
    if (!genreIds.length) return this.shelf('popular', limit);

    const watchedIds = watched.map((w) => w.movieId).filter((id): id is string => Boolean(id));
    const rows = await moviesRepository.findMany(
      { ...publicListWhere(), id: { notIn: watchedIds }, genres: { some: { genreId: { in: genreIds } } } },
      [{ popularityScore: 'desc' }, { ratingAvg: 'desc' }, { id: 'asc' }],
      limit,
    );
    return rows.map(toMovieSummary);
  },

  async similar(idOrSlug: string, limit: number) {
    const movie = await moviesRepository.findPublicDetail(idOrSlug);
    if (!movie) throw AppError.notFound('Movie');
    const genreIds = movie.genres.map((g) => g.genre.id);
    if (!genreIds.length) return [];
    return cache.wrap(CacheNamespace.CATALOG, ['movies.similar', movie.id, limit], CATALOG_TTL, async () => {
      // Over-fetch candidates sharing any genre, then rank by number of shared genres.
      const candidates = await moviesRepository.findMany(
        { ...publicListWhere(), id: { not: movie.id }, genres: { some: { genreId: { in: genreIds } } } },
        [{ popularityScore: 'desc' }, { id: 'asc' }],
        limit * 4,
      );
      const genreSet = new Set(genreIds);
      return candidates
        .map((c) => ({ c, shared: c.genres.filter((g) => genreSet.has(g.genre.id)).length }))
        .sort((a, b) => b.shared - a.shared)
        .slice(0, limit)
        .map(({ c }) => toMovieSummary(c));
    });
  },

  async detail(idOrSlug: string, userId?: string) {
    const movie = await moviesRepository.findPublicDetail(idOrSlug);
    if (!movie) throw AppError.notFound('Movie');
    let viewer = null;
    if (userId) {
      const [watch, rating, progress] = await Promise.all([
        prisma.watchlistItem.findUnique({ where: { userId_movieId: { userId, movieId: movie.id } }, select: { id: true } }),
        prisma.rating.findUnique({ where: { userId_movieId: { userId, movieId: movie.id } }, select: { score: true } }),
        prisma.watchProgress.findUnique({
          where: { userId_movieId: { userId, movieId: movie.id } },
          select: { positionSeconds: true, durationSeconds: true, completed: true },
        }),
      ]);
      viewer = { inWatchlist: Boolean(watch), myRating: rating?.score ?? null, progress };
    }
    return { ...toMovieDetail(movie), viewer };
  },

  // ───────────── Admin ─────────────

  async adminList(query: z.infer<typeof adminListMoviesQuery>) {
    const where: Prisma.MovieWhereInput = {
      deletedAt: query.deleted ? { not: null } : null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.accessTier ? { accessTier: query.accessTier } : {}),
      ...(query.q ? { title: containsInsensitive(query.q) } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.movie.findMany({ where, orderBy: { [query.sort.field]: query.sort.direction }, include: movieDetailInclude, ...toSkipTake(query) }),
      prisma.movie.count({ where }),
    ]);
    return { items: rows.map(toAdminMovie), meta: buildMeta(query, total) };
  },

  async adminGet(id: string) {
    const movie = await moviesRepository.findAdminDetail(id);
    if (!movie) throw AppError.notFound('Movie');
    return toAdminMovie(movie);
  },

  async create(input: CreateMovieInput, actor: Actor) {
    await Promise.all([
      assertGenres(input.genreIds),
      mediaService.assertExists(input.posterImageId, 'posterImageId'),
      mediaService.assertExists(input.backdropImageId, 'backdropImageId'),
    ]);
    if (input.slug && (await moviesRepository.slugExists(input.slug))) {
      throw AppError.conflict('Slug already in use', [{ path: 'slug', message: 'must be unique' }]);
    }
    const slug = input.slug ?? (await uniqueSlug(input.title, (s) => moviesRepository.slugExists(s)));
    const movie = await prisma.$transaction(async (tx) => {
      const created = await tx.movie.create({
        data: {
          ...(toMovieData(input) as Prisma.MovieUncheckedCreateInput),
          title: input.title,
          slug,
          genres: input.genreIds ? { create: [...new Set(input.genreIds)].map((genreId) => ({ genreId })) } : undefined,
        },
      });
      await writeAudit({ actorId: actor.userId, action: 'movie.create', entityType: 'movie', entityId: created.id, client: actor.client }, tx);
      return created;
    });
    return this.adminGet(movie.id);
  },

  async update(id: string, input: UpdateMovieInput, actor: Actor) {
    const existing = await prisma.movie.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
    if (!existing) throw AppError.notFound('Movie');
    await Promise.all([
      assertGenres(input.genreIds),
      mediaService.assertExists(input.posterImageId, 'posterImageId'),
      mediaService.assertExists(input.backdropImageId, 'backdropImageId'),
    ]);
    await prisma.$transaction(async (tx) => {
      await tx.movie.update({ where: { id }, data: { ...toMovieData(input), slug: input.slug } });
      if (input.genreIds) {
        await tx.movieGenre.deleteMany({ where: { movieId: id } });
        await tx.movieGenre.createMany({ data: [...new Set(input.genreIds)].map((genreId) => ({ movieId: id, genreId })) });
      }
      await writeAudit(
        { actorId: actor.userId, action: 'movie.update', entityType: 'movie', entityId: id, metadata: { fields: Object.keys(input) }, client: actor.client },
        tx,
      );
    });
    await invalidateCatalog();
    return this.adminGet(id);
  },

  async setStatus(id: string, status: ContentStatus, actor: Actor) {
    const movie = await prisma.movie.findFirst({ where: { id, deletedAt: null } });
    if (!movie) throw AppError.notFound('Movie');
    if (status === 'PUBLISHED' && !movie.title) throw AppError.badRequest('Movie needs a title before publishing');
    await prisma.$transaction(async (tx) => {
      await tx.movie.update({
        where: { id },
        data: { status, publishedAt: status === 'PUBLISHED' ? (movie.publishedAt ?? new Date()) : movie.publishedAt },
      });
      await writeAudit(
        { actorId: actor.userId, action: `movie.${status.toLowerCase()}`, entityType: 'movie', entityId: id, severity: 'MEDIUM', client: actor.client },
        tx,
      );
    });
    await invalidateCatalog();
    return this.adminGet(id);
  },

  async softDelete(id: string, actor: Actor) {
    const result = await prisma.movie.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), featured: false } });
    if (result.count === 0) throw AppError.notFound('Movie');
    await writeAudit({ actorId: actor.userId, action: 'movie.delete', entityType: 'movie', entityId: id, severity: 'MEDIUM', client: actor.client });
    await invalidateCatalog();
  },

  async restore(id: string, actor: Actor) {
    const result = await prisma.movie.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null, status: 'DRAFT' } });
    if (result.count === 0) throw AppError.notFound('Deleted movie');
    await writeAudit({ actorId: actor.userId, action: 'movie.restore', entityType: 'movie', entityId: id, client: actor.client });
    await invalidateCatalog();
    return this.adminGet(id);
  },

  async setCast(id: string, input: z.infer<typeof setCastBody>, actor: Actor) {
    await this.adminGet(id);
    const personIds = [...new Set(input.cast.map((c) => c.personId))];
    const found = await prisma.person.count({ where: { id: { in: personIds }, deletedAt: null } });
    if (found !== personIds.length) throw AppError.validation([{ path: 'cast', message: 'One or more people do not exist' }]);
    await prisma.$transaction(async (tx) => {
      await tx.movieCast.deleteMany({ where: { movieId: id } });
      await tx.movieCast.createMany({
        data: input.cast.map((c) => ({ movieId: id, personId: c.personId, characterName: c.characterName ?? null, order: c.order })),
        skipDuplicates: true,
      });
      await writeAudit({ actorId: actor.userId, action: 'movie.set_cast', entityType: 'movie', entityId: id, client: actor.client }, tx);
    });
    await invalidateCatalog();
    return this.adminGet(id);
  },

  async setCrew(id: string, input: z.infer<typeof setCrewBody>, actor: Actor) {
    await this.adminGet(id);
    const personIds = [...new Set(input.crew.map((c) => c.personId))];
    const found = await prisma.person.count({ where: { id: { in: personIds }, deletedAt: null } });
    if (found !== personIds.length) throw AppError.validation([{ path: 'crew', message: 'One or more people do not exist' }]);
    await prisma.$transaction(async (tx) => {
      await tx.movieCrew.deleteMany({ where: { movieId: id } });
      await tx.movieCrew.createMany({
        data: input.crew.map((c) => ({ movieId: id, personId: c.personId, job: c.job, jobTitle: c.jobTitle ?? null })),
        skipDuplicates: true,
      });
      await writeAudit({ actorId: actor.userId, action: 'movie.set_crew', entityType: 'movie', entityId: id, client: actor.client }, tx);
    });
    await invalidateCatalog();
    return this.adminGet(id);
  },

  /** All-or-nothing bulk import (single transaction). Genres are matched by slug. */
  async import(input: z.infer<typeof importMoviesBody>, actor: Actor) {
    const slugs = [...new Set(input.movies.flatMap((m) => m.genres ?? []))];
    const genres = await prisma.genre.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } });
    const genreBySlug = new Map(genres.map((g) => [g.slug, g.id]));
    const missing = slugs.filter((s) => !genreBySlug.has(s));
    if (missing.length) throw AppError.validation([{ path: 'movies.genres', message: `Unknown genres: ${missing.join(', ')}` }]);

    const created = await prisma.$transaction(
      async (tx) => {
        const ids: string[] = [];
        for (const m of input.movies) {
          const slug = m.slug ?? (await uniqueSlug(m.title, (s) => moviesRepository.slugExists(s, tx)));
          const movie = await tx.movie.create({
            data: {
              ...(toMovieData(m) as Prisma.MovieUncheckedCreateInput),
              title: m.title,
              slug,
              status: input.publish ? 'PUBLISHED' : 'DRAFT',
              publishedAt: input.publish ? new Date() : null,
              genres: { create: (m.genres ?? []).map((s) => ({ genreId: genreBySlug.get(s) as string })) },
            },
            select: { id: true },
          });
          ids.push(movie.id);
        }
        await writeAudit(
          { actorId: actor.userId, action: 'movie.import', entityType: 'movie', severity: 'MEDIUM', metadata: { count: ids.length }, client: actor.client },
          tx,
        );
        return ids;
      },
      { timeout: 60_000 },
    );
    await invalidateCatalog();
    return { imported: created.length, ids: created };
  },

  async export(format: 'json' | 'csv', status?: ContentStatus) {
    const rows = await prisma.movie.findMany({
      where: { deletedAt: null, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
      take: 10_000,
      include: { genres: { select: { genre: { select: { slug: true } } } } },
    });
    const records = rows.map((m) => ({
      id: m.id,
      title: m.title,
      originalTitle: m.originalTitle,
      slug: m.slug,
      status: m.status,
      visibility: m.visibility,
      accessTier: m.accessTier,
      releaseDate: m.releaseDate?.toISOString().slice(0, 10) ?? null,
      durationMinutes: m.durationMinutes,
      ageRating: m.ageRating,
      language: m.language,
      country: m.country,
      genres: m.genres.map((g) => g.genre.slug).join('|'),
      ratingAvg: m.ratingAvg,
      ratingCount: m.ratingCount,
      viewCount: m.viewCount,
    }));
    if (format === 'json') return { contentType: 'application/json', body: JSON.stringify(records, null, 2) };
    const header = Object.keys(records[0] ?? { id: '' });
    const lines = [header.join(','), ...records.map((r) => header.map((h) => csvCell(r[h as keyof typeof r])).join(','))];
    return { contentType: 'text/csv; charset=utf-8', body: lines.join('\n') };
  },
};
