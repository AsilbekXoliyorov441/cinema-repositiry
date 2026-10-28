import { containsInsensitive } from '../../common/utils/search.js';
import { Prisma, type ContentStatus } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { publicContentWhere } from '../../common/utils/content.js';
import { buildMeta, toSkipTake } from '../../common/utils/pagination.js';
import { uniqueSlug } from '../../common/utils/slug.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { mediaService } from '../media/media.service.js';
import { imageSelect, toImageView } from '../media/media.urls.js';
import type { z } from 'zod';
import type { UpdateSeriesInput, adminListSeriesQuery, createSeriesBody, listSeriesQuery } from './series.schemas.js';

type Actor = { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } };

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (d: string | null | undefined) => (d === undefined ? undefined : d === null ? null : new Date(d));

export const publicSeasonWhere = { status: 'PUBLISHED' as const, deletedAt: null };

const summaryInclude = {
  poster: { select: imageSelect },
  backdrop: { select: imageSelect },
  genres: { select: { genre: { select: { id: true, name: true, slug: true } } } },
  _count: { select: { seasons: { where: publicSeasonWhere } } },
} satisfies Prisma.SeriesInclude;

type SummaryRow = Prisma.SeriesGetPayload<{ include: typeof summaryInclude }>;

function toSummary(s: SummaryRow) {
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    originalTitle: s.originalTitle,
    firstAirDate: iso(s.firstAirDate),
    ageRating: s.ageRating,
    accessTier: s.accessTier,
    featured: s.featured,
    poster: toImageView(s.poster),
    backdrop: toImageView(s.backdrop),
    genres: s.genres.map((g) => g.genre),
    seasonCount: s._count.seasons,
  };
}

function detailInclude(publicOnly: boolean) {
  return {
    ...summaryInclude,
    seasons: {
      where: publicOnly ? publicSeasonWhere : { deletedAt: null },
      orderBy: { seasonNumber: 'asc' as const },
      include: {
        poster: { select: imageSelect },
        _count: { select: { episodes: { where: publicOnly ? { ...publicContentWhere() } : { deletedAt: null } } } },
      },
    },
  } satisfies Prisma.SeriesInclude;
}

type DetailRow = Prisma.SeriesGetPayload<{ include: ReturnType<typeof detailInclude> }>;

function toDetail(s: DetailRow) {
  return {
    ...toSummary(s),
    overview: s.overview,
    lastAirDate: iso(s.lastAirDate),
    language: s.language,
    country: s.country,
    trailerUrl: s.trailerUrl,
    seoTitle: s.seoTitle,
    seoDescription: s.seoDescription,
    seasons: s.seasons.map((season) => ({
      id: season.id,
      seasonNumber: season.seasonNumber,
      title: season.title,
      airDate: iso(season.airDate),
      poster: toImageView(season.poster),
      episodeCount: season._count.episodes,
    })),
  };
}

function toData(input: UpdateSeriesInput): Prisma.SeriesUncheckedUpdateInput {
  return {
    title: input.title,
    originalTitle: input.originalTitle,
    overview: input.overview,
    firstAirDate: toDate(input.firstAirDate),
    lastAirDate: toDate(input.lastAirDate),
    ageRating: input.ageRating,
    language: input.language,
    country: input.country,
    visibility: input.visibility,
    accessTier: input.accessTier,
    featured: input.featured,
    posterImageId: input.posterImageId,
    backdropImageId: input.backdropImageId,
    trailerUrl: input.trailerUrl,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
    externalIds: input.externalIds === null ? Prisma.DbNull : input.externalIds,
  };
}

export function publicSeriesWhere(): Prisma.SeriesWhereInput {
  return { ...publicContentWhere(), visibility: { in: ['PUBLIC', 'UNLISTED'] } };
}

async function assertRefs(input: UpdateSeriesInput) {
  if (input.genreIds?.length) {
    const count = await prisma.genre.count({ where: { id: { in: input.genreIds } } });
    if (count !== new Set(input.genreIds).size) throw AppError.validation([{ path: 'genreIds', message: 'Unknown genre' }]);
  }
  await mediaService.assertExists(input.posterImageId, 'posterImageId');
  await mediaService.assertExists(input.backdropImageId, 'backdropImageId');
}

export const seriesService = {
  list(query: z.infer<typeof listSeriesQuery>) {
    return cache.wrap(CacheNamespace.CATALOG, ['series.list', query], 120, async () => {
      const where: Prisma.SeriesWhereInput = {
        ...publicContentWhere(),
        visibility: 'PUBLIC',
        ...(query.q ? { title: containsInsensitive(query.q) } : {}),
        ...(query.genre ? { genres: { some: { genre: { slug: query.genre } } } } : {}),
        ...(query.accessTier ? { accessTier: query.accessTier } : {}),
      };
      const [rows, total] = await prisma.$transaction([
        prisma.series.findMany({
          where,
          include: summaryInclude,
          orderBy: [{ [query.sort.field]: query.sort.direction }, { id: 'asc' }],
          ...toSkipTake(query),
        }),
        prisma.series.count({ where }),
      ]);
      return { items: rows.map(toSummary), meta: buildMeta(query, total) };
    });
  },

  async detail(idOrSlug: string) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const series = await prisma.series.findFirst({
      where: { ...publicSeriesWhere(), ...(isUuid ? { id: idOrSlug } : { slug: idOrSlug }) },
      include: detailInclude(true),
    });
    if (!series) throw AppError.notFound('Series');
    return toDetail(series);
  },

  async adminList(query: z.infer<typeof adminListSeriesQuery>) {
    const where: Prisma.SeriesWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { title: containsInsensitive(query.q) } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.series.findMany({ where, include: detailInclude(false), orderBy: { [query.sort.field]: query.sort.direction }, ...toSkipTake(query) }),
      prisma.series.count({ where }),
    ]);
    return { items: rows.map((s) => this.toAdmin(s)), meta: buildMeta(query, total) };
  },

  toAdmin(s: DetailRow) {
    return {
      ...toDetail(s),
      status: s.status,
      visibility: s.visibility,
      publishedAt: s.publishedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  },

  async adminGet(id: string) {
    const s = await prisma.series.findFirst({ where: { id, deletedAt: null }, include: detailInclude(false) });
    if (!s) throw AppError.notFound('Series');
    return this.toAdmin(s);
  },

  async create(input: z.infer<typeof createSeriesBody>, actor: Actor) {
    await assertRefs(input);
    const slug = input.slug ?? (await uniqueSlug(input.title, async (s) => Boolean(await prisma.series.findUnique({ where: { slug: s } }))));
    const created = await prisma.series.create({
      data: {
        ...(toData(input) as Prisma.SeriesUncheckedCreateInput),
        title: input.title,
        slug,
        genres: input.genreIds ? { create: [...new Set(input.genreIds)].map((genreId) => ({ genreId })) } : undefined,
      },
    });
    await writeAudit({ actorId: actor.userId, action: 'series.create', entityType: 'series', entityId: created.id, client: actor.client });
    return this.adminGet(created.id);
  },

  async update(id: string, input: UpdateSeriesInput, actor: Actor) {
    await this.adminGet(id);
    await assertRefs(input);
    await prisma.$transaction(async (tx) => {
      await tx.series.update({ where: { id }, data: { ...toData(input), slug: input.slug } });
      if (input.genreIds) {
        await tx.seriesGenre.deleteMany({ where: { seriesId: id } });
        await tx.seriesGenre.createMany({ data: [...new Set(input.genreIds)].map((genreId) => ({ seriesId: id, genreId })) });
      }
      await writeAudit({ actorId: actor.userId, action: 'series.update', entityType: 'series', entityId: id, client: actor.client }, tx);
    });
    await cache.invalidate(CacheNamespace.CATALOG);
    return this.adminGet(id);
  },

  async setStatus(id: string, status: ContentStatus, actor: Actor) {
    const s = await prisma.series.findFirst({ where: { id, deletedAt: null } });
    if (!s) throw AppError.notFound('Series');
    await prisma.series.update({
      where: { id },
      data: { status, publishedAt: status === 'PUBLISHED' ? (s.publishedAt ?? new Date()) : s.publishedAt },
    });
    await writeAudit({ actorId: actor.userId, action: `series.${status.toLowerCase()}`, entityType: 'series', entityId: id, severity: 'MEDIUM', client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
    return this.adminGet(id);
  },

  async softDelete(id: string, actor: Actor) {
    const r = await prisma.series.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
    if (r.count === 0) throw AppError.notFound('Series');
    await writeAudit({ actorId: actor.userId, action: 'series.delete', entityType: 'series', entityId: id, severity: 'MEDIUM', client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
  },
};
