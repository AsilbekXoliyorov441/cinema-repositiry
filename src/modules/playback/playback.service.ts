import type { AccessTier, AgeRating, Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { PLAN_FEATURES } from '../../common/constants/features.js';
import type { AuthContext } from '../../common/types/auth.js';
import { publicContentWhere } from '../../common/utils/content.js';
import { utcDay } from '../../common/utils/duration.js';
import { canAccessTier, checkAge, hasFeature, type Entitlement } from '../subscriptions/entitlement.js';
import { entitlementService } from '../subscriptions/entitlement.service.js';
import { publicEpisodeWhere } from '../episodes/episodes.service.js';
import { signPlaybackUrl } from './signed-url.js';
import type { PlaybackResponse } from './playback.schemas.js';

const videoSelect = {
  id: true,
  provider: true,
  manifestType: true,
  playbackUrl: true,
  qualityLabel: true,
  language: true,
  isDefault: true,
  requiresSigning: true,
  premiumOnly: true,
} satisfies Prisma.VideoAssetSelect;
type VideoRow = Prisma.VideoAssetGetPayload<{ select: typeof videoSelect }>;

const subtitleSelect = { id: true, language: true, label: true, url: true, isDefault: true } as const;

/**
 * Shared authorization for any playable item: age gate first, then tier entitlement.
 * Entitlement is always evaluated from the database for this request.
 */
export async function authorizePlayback(auth: AuthContext, content: { accessTier: AccessTier; ageRating: AgeRating }): Promise<Entitlement> {
  const age = checkAge(auth.birthDate, content.ageRating);
  if (!age.allowed) {
    throw AppError.forbidden(
      auth.birthDate ? `This title is restricted to viewers aged ${age.minAge}+` : 'Add your birth date to your profile to watch 18+ titles',
      ErrorCode.AGE_RESTRICTED,
    );
  }
  const entitlement = await entitlementService.forUser(auth.userId);
  if (!canAccessTier(entitlement, content.accessTier)) {
    throw AppError.forbidden('An active Pro subscription is required to watch this title', ErrorCode.SUBSCRIPTION_REQUIRED);
  }
  return entitlement;
}

/** Turns stored video assets into client sources: filters premium variants and signs URLs. Admin-only fields never leave. */
export function buildSources(videos: VideoRow[], entitlement: Entitlement): PlaybackResponse['sources'] {
  const sources: PlaybackResponse['sources'] = [];
  for (const v of videos) {
    if (v.premiumOnly && !hasFeature(entitlement, PLAN_FEATURES.HD_QUALITY)) continue;
    let url = v.playbackUrl;
    let expiresAt: string | null = null;
    if (v.requiresSigning) {
      if (!env.PLAYBACK_SIGNING_SECRET) {
        logger.warn({ videoId: v.id }, 'Video requires signing but PLAYBACK_SIGNING_SECRET is not set — source skipped');
        continue;
      }
      const signed = signPlaybackUrl(v.playbackUrl, env.PLAYBACK_SIGNING_SECRET, env.PLAYBACK_URL_TTL_SECONDS);
      url = signed.url;
      expiresAt = signed.expiresAt.toISOString();
    }
    sources.push({
      id: v.id,
      type: v.manifestType,
      provider: v.provider,
      url,
      quality: v.qualityLabel,
      language: v.language,
      isDefault: v.isDefault,
      expiresAt,
    });
  }
  return sources.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** Records one history row per user/content/day; the first view of the day increments the view counter. */
async function recordView(userId: string, target: { movieId: string } | { episodeId: string }): Promise<void> {
  const watchedOn = utcDay();
  try {
    if ('movieId' in target) {
      const existing = await prisma.watchHistory.findUnique({
        where: { userId_movieId_watchedOn: { userId, movieId: target.movieId, watchedOn } },
        select: { id: true },
      });
      if (existing) {
        await prisma.watchHistory.update({ where: { id: existing.id }, data: { lastWatchedAt: new Date() } });
        return;
      }
      await prisma.$transaction([
        prisma.watchHistory.create({ data: { userId, movieId: target.movieId, watchedOn } }),
        prisma.movie.update({ where: { id: target.movieId }, data: { viewCount: { increment: 1 } } }),
      ]);
    } else {
      await prisma.watchHistory.upsert({
        where: { userId_episodeId_watchedOn: { userId, episodeId: target.episodeId, watchedOn } },
        create: { userId, episodeId: target.episodeId, watchedOn },
        update: { lastWatchedAt: new Date() },
      });
    }
  } catch (err) {
    // Concurrent first views can race on the unique key; history is best-effort and must not block playback.
    logger.debug({ err: (err as Error).message }, 'recordView skipped');
  }
}

export const playbackService = {
  async movie(auth: AuthContext, movieId: string): Promise<PlaybackResponse> {
    const movie = await prisma.movie.findFirst({
      where: { id: movieId, ...publicContentWhere(), visibility: { in: ['PUBLIC', 'UNLISTED'] } },
      select: {
        id: true,
        title: true,
        accessTier: true,
        ageRating: true,
        durationMinutes: true,
        videos: { where: { status: 'ACTIVE', assetType: 'FEATURE' }, select: videoSelect },
        subtitles: { select: subtitleSelect },
      },
    });
    if (!movie) throw AppError.notFound('Movie');

    const entitlement = await authorizePlayback(auth, movie);
    const sources = buildSources(movie.videos, entitlement);
    if (!sources.length) throw AppError.notFound('No playable source is available for this title');

    const [progress] = await Promise.all([
      prisma.watchProgress.findUnique({
        where: { userId_movieId: { userId: auth.userId, movieId: movie.id } },
        select: { positionSeconds: true, completed: true },
      }),
      recordView(auth.userId, { movieId: movie.id }),
    ]);

    return {
      contentType: 'movie',
      contentId: movie.id,
      title: movie.title,
      accessTier: movie.accessTier,
      durationSeconds: movie.durationMinutes ? movie.durationMinutes * 60 : null,
      sources,
      subtitles: movie.subtitles,
      resume: progress,
    };
  },

  async episode(auth: AuthContext, episodeId: string): Promise<PlaybackResponse> {
    const episode = await prisma.episode.findFirst({
      where: { id: episodeId, ...publicEpisodeWhere() },
      select: {
        id: true,
        title: true,
        accessTier: true,
        durationMinutes: true,
        season: { select: { series: { select: { accessTier: true, ageRating: true } } } },
        videos: { where: { status: 'ACTIVE', assetType: 'FEATURE' }, select: videoSelect },
        subtitles: { select: subtitleSelect },
      },
    });
    if (!episode) throw AppError.notFound('Episode');

    const series = episode.season.series;
    const accessTier = episode.accessTier ?? series.accessTier;
    const entitlement = await authorizePlayback(auth, { accessTier, ageRating: series.ageRating });
    const sources = buildSources(episode.videos, entitlement);
    if (!sources.length) throw AppError.notFound('No playable source is available for this episode');

    const [progress] = await Promise.all([
      prisma.watchProgress.findUnique({
        where: { userId_episodeId: { userId: auth.userId, episodeId: episode.id } },
        select: { positionSeconds: true, completed: true },
      }),
      recordView(auth.userId, { episodeId: episode.id }),
    ]);

    return {
      contentType: 'episode',
      contentId: episode.id,
      title: episode.title,
      accessTier,
      durationSeconds: episode.durationMinutes ? episode.durationMinutes * 60 : null,
      sources,
      subtitles: episode.subtitles,
      resume: progress,
    };
  },
};
