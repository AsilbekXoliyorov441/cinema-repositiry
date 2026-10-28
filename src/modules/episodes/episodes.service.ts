import type { AccessTier, Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { publicContentWhere } from '../../common/utils/content.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { mediaService } from '../media/media.service.js';
import { imageSelect, toImageView } from '../media/media.urls.js';
import { publicSeasonWhere, publicSeriesWhere } from '../series/series.service.js';
import type { z } from 'zod';
import type { createSeasonBody, updateSeasonBody } from '../seasons/seasons.schemas.js';
import type { createEpisodeBody, updateEpisodeBody } from './episodes.schemas.js';

type Actor = { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } };

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (d: string | null | undefined) => (d === undefined ? undefined : d === null ? null : new Date(d));

type EpisodeRow = Prisma.EpisodeGetPayload<{ include: { still: { select: typeof imageSelect } } }>;

function toEpisode(e: EpisodeRow, seriesTier: AccessTier) {
  return {
    id: e.id,
    episodeNumber: e.episodeNumber,
    title: e.title,
    overview: e.overview,
    airDate: iso(e.airDate),
    durationMinutes: e.durationMinutes,
    accessTier: e.accessTier ?? seriesTier,
    still: toImageView(e.still),
  };
}

function toAdminEpisode(e: EpisodeRow, seriesTier: AccessTier) {
  return { ...toEpisode(e, seriesTier), seasonId: e.seasonId, ownAccessTier: e.accessTier, status: e.status, publishedAt: e.publishedAt?.toISOString() ?? null };
}

/** Where-clause for an episode that is publicly playable/visible right now (episode, season and series all public). */
export function publicEpisodeWhere(): Prisma.EpisodeWhereInput {
  return { ...publicContentWhere(), season: { ...publicSeasonWhere, series: publicSeriesWhere() } };
}

async function seasonOr404(seasonId: string) {
  const season = await prisma.season.findFirst({ where: { id: seasonId, deletedAt: null }, include: { series: { select: { accessTier: true } } } });
  if (!season) throw AppError.notFound('Season');
  return season;
}

export const seasonsService = {
  async publicSeason(seriesIdOrSlug: string, seasonNumber: number) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(seriesIdOrSlug);
    const season = await prisma.season.findFirst({
      where: { ...publicSeasonWhere, seasonNumber, series: { ...publicSeriesWhere(), ...(isUuid ? { id: seriesIdOrSlug } : { slug: seriesIdOrSlug }) } },
      include: {
        poster: { select: imageSelect },
        series: { select: { accessTier: true } },
        episodes: { where: publicContentWhere(), orderBy: { episodeNumber: 'asc' }, include: { still: { select: imageSelect } } },
      },
    });
    if (!season) throw AppError.notFound('Season');
    return {
      id: season.id,
      seriesId: season.seriesId,
      seasonNumber: season.seasonNumber,
      title: season.title,
      overview: season.overview,
      airDate: iso(season.airDate),
      poster: toImageView(season.poster),
      episodes: season.episodes.map((e) => toEpisode(e, season.series.accessTier)),
    };
  },

  async create(seriesId: string, input: z.infer<typeof createSeasonBody>, actor: Actor) {
    const series = await prisma.series.findFirst({ where: { id: seriesId, deletedAt: null }, select: { id: true } });
    if (!series) throw AppError.notFound('Series');
    await mediaService.assertExists(input.posterImageId, 'posterImageId');
    const season = await prisma.season.create({
      data: {
        seriesId,
        seasonNumber: input.seasonNumber,
        title: input.title ?? null,
        overview: input.overview ?? null,
        airDate: toDate(input.airDate) ?? null,
        posterImageId: input.posterImageId ?? null,
        status: input.status ?? 'DRAFT',
      },
    });
    await writeAudit({ actorId: actor.userId, action: 'season.create', entityType: 'season', entityId: season.id, client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
    return season;
  },

  async update(id: string, input: z.infer<typeof updateSeasonBody>, actor: Actor) {
    await seasonOr404(id);
    await mediaService.assertExists(input.posterImageId, 'posterImageId');
    const season = await prisma.season.update({
      where: { id },
      data: { ...input, airDate: toDate(input.airDate) },
    });
    await writeAudit({ actorId: actor.userId, action: 'season.update', entityType: 'season', entityId: id, client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
    return season;
  },

  async remove(id: string, actor: Actor) {
    await seasonOr404(id);
    await prisma.season.update({ where: { id }, data: { deletedAt: new Date() } });
    await writeAudit({ actorId: actor.userId, action: 'season.delete', entityType: 'season', entityId: id, severity: 'MEDIUM', client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
  },
};

export const episodesService = {
  async publicEpisode(id: string) {
    const e = await prisma.episode.findFirst({
      where: { id, ...publicEpisodeWhere() },
      include: { still: { select: imageSelect }, season: { select: { series: { select: { accessTier: true } } } } },
    });
    if (!e) throw AppError.notFound('Episode');
    return toEpisode(e, e.season.series.accessTier);
  },

  async adminList(seasonId: string) {
    const season = await seasonOr404(seasonId);
    const rows = await prisma.episode.findMany({
      where: { seasonId, deletedAt: null },
      orderBy: { episodeNumber: 'asc' },
      include: { still: { select: imageSelect } },
    });
    return rows.map((e) => toAdminEpisode(e, season.series.accessTier));
  },

  async create(seasonId: string, input: z.infer<typeof createEpisodeBody>, actor: Actor) {
    const season = await seasonOr404(seasonId);
    await mediaService.assertExists(input.stillImageId, 'stillImageId');
    const status = input.status ?? 'DRAFT';
    const e = await prisma.episode.create({
      data: {
        seasonId,
        episodeNumber: input.episodeNumber,
        title: input.title,
        overview: input.overview ?? null,
        airDate: toDate(input.airDate) ?? null,
        durationMinutes: input.durationMinutes ?? null,
        stillImageId: input.stillImageId ?? null,
        accessTier: input.accessTier ?? null,
        status,
        publishedAt: status === 'PUBLISHED' ? new Date() : null,
      },
      include: { still: { select: imageSelect } },
    });
    await writeAudit({ actorId: actor.userId, action: 'episode.create', entityType: 'episode', entityId: e.id, client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
    return toAdminEpisode(e, season.series.accessTier);
  },

  async update(id: string, input: z.infer<typeof updateEpisodeBody>, actor: Actor) {
    const existing = await prisma.episode.findFirst({
      where: { id, deletedAt: null },
      include: { season: { select: { series: { select: { accessTier: true } } } } },
    });
    if (!existing) throw AppError.notFound('Episode');
    await mediaService.assertExists(input.stillImageId, 'stillImageId');
    const e = await prisma.episode.update({
      where: { id },
      data: {
        ...input,
        airDate: toDate(input.airDate),
        publishedAt: input.status === 'PUBLISHED' && !existing.publishedAt ? new Date() : undefined,
      },
      include: { still: { select: imageSelect } },
    });
    await writeAudit({ actorId: actor.userId, action: 'episode.update', entityType: 'episode', entityId: id, client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
    return toAdminEpisode(e, existing.season.series.accessTier);
  },

  async remove(id: string, actor: Actor) {
    const r = await prisma.episode.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
    if (r.count === 0) throw AppError.notFound('Episode');
    await writeAudit({ actorId: actor.userId, action: 'episode.delete', entityType: 'episode', entityId: id, severity: 'MEDIUM', client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
  },
};
