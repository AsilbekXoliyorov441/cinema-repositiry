import type { Prisma, VideoAsset } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { probeUrl } from '../../common/utils/url-safety.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import type { z } from 'zod';
import type { createVideoBody, subtitleBody, updateVideoBody } from './playback.schemas.js';

type Actor = { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } };
type Owner = { movieId: string } | { episodeId: string };

export function toVideoView(v: VideoAsset) {
  return {
    ...v,
    lastCheckedAt: v.lastCheckedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

async function assertOwner(owner: Owner): Promise<void> {
  const exists =
    'movieId' in owner
      ? await prisma.movie.findFirst({ where: { id: owner.movieId, deletedAt: null }, select: { id: true } })
      : await prisma.episode.findFirst({ where: { id: owner.episodeId, deletedAt: null }, select: { id: true } });
  if (!exists) throw AppError.notFound('movieId' in owner ? 'Movie' : 'Episode');
}

function ownerWhere(owner: Owner): Prisma.VideoAssetWhereInput {
  return 'movieId' in owner ? { movieId: owner.movieId } : { episodeId: owner.episodeId };
}

export const videoAssetsService = {
  async list(owner: Owner) {
    await assertOwner(owner);
    const rows = await prisma.videoAsset.findMany({ where: ownerWhere(owner), orderBy: [{ assetType: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(toVideoView);
  },

  async create(owner: Owner, input: z.infer<typeof createVideoBody>, actor: Actor) {
    await assertOwner(owner);
    const video = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.videoAsset.updateMany({ where: { ...ownerWhere(owner), assetType: input.assetType }, data: { isDefault: false } });
      }
      const created = await tx.videoAsset.create({ data: { ...input, ...owner } as Prisma.VideoAssetUncheckedCreateInput });
      await writeAudit(
        // The URL itself is not logged: it may contain provider tokens.
        { actorId: actor.userId, action: 'video.create', entityType: 'video', entityId: created.id, metadata: { ...owner, provider: input.provider }, client: actor.client },
        tx,
      );
      return created;
    });
    await cache.invalidate(CacheNamespace.CATALOG);
    return toVideoView(video);
  },

  async update(id: string, input: z.infer<typeof updateVideoBody>, actor: Actor) {
    const existing = await prisma.videoAsset.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound('Video');
    const merged = { ...existing, ...input };
    if (merged.requiresSigning && merged.provider !== 'SIGNED_CDN') {
      throw AppError.validation([{ path: 'requiresSigning', message: 'Only SIGNED_CDN sources can be signed' }]);
    }
    const video = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.videoAsset.updateMany({
          where: { movieId: existing.movieId, episodeId: existing.episodeId, assetType: merged.assetType, id: { not: id } },
          data: { isDefault: false },
        });
      }
      const updated = await tx.videoAsset.update({ where: { id }, data: input });
      await writeAudit({ actorId: actor.userId, action: 'video.update', entityType: 'video', entityId: id, metadata: { fields: Object.keys(input) }, client: actor.client }, tx);
      return updated;
    });
    await cache.invalidate(CacheNamespace.CATALOG);
    return toVideoView(video);
  },

  async remove(id: string, actor: Actor) {
    const r = await prisma.videoAsset.deleteMany({ where: { id } });
    if (r.count === 0) throw AppError.notFound('Video');
    await writeAudit({ actorId: actor.userId, action: 'video.delete', entityType: 'video', entityId: id, client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
  },

  /** Availability probe — the only place the server fetches an admin-provided URL; guarded against SSRF. */
  async check(id: string) {
    const video = await prisma.videoAsset.findUnique({ where: { id } });
    if (!video) throw AppError.notFound('Video');
    if (video.manifestType === 'EMBED') throw AppError.badRequest('Embed sources cannot be probed');
    const result = await probeUrl(video.playbackUrl).catch((err: unknown) => {
      if (err instanceof AppError) throw err;
      return { status: 0, contentType: null, finalUrl: video.playbackUrl };
    });
    const updated = await prisma.videoAsset.update({ where: { id }, data: { lastCheckedAt: new Date(), lastCheckStatus: result.status } });
    return { reachable: result.status >= 200 && result.status < 400, status: result.status, contentType: result.contentType, video: toVideoView(updated) };
  },

  async addSubtitle(owner: Owner, input: z.infer<typeof subtitleBody>, actor: Actor) {
    await assertOwner(owner);
    const subtitle = await prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.subtitle.updateMany({ where: owner, data: { isDefault: false } });
      return tx.subtitle.create({ data: { ...input, ...owner } });
    });
    await writeAudit({ actorId: actor.userId, action: 'subtitle.create', entityType: 'subtitle', entityId: subtitle.id, client: actor.client });
    return subtitle;
  },

  async listSubtitles(owner: Owner) {
    await assertOwner(owner);
    return prisma.subtitle.findMany({ where: owner, orderBy: { language: 'asc' } });
  },

  async removeSubtitle(id: string, actor: Actor) {
    const r = await prisma.subtitle.deleteMany({ where: { id } });
    if (r.count === 0) throw AppError.notFound('Subtitle');
    await writeAudit({ actorId: actor.userId, action: 'subtitle.delete', entityType: 'subtitle', entityId: id, client: actor.client });
  },
};
