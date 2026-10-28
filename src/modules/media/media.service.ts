import { randomUUID } from 'node:crypto';
import type { MediaKind, MediaVisibility, Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/app-error.js';
import { sha256Hex } from '../../common/utils/crypto.js';
import { buildMeta, toSkipTake, type PaginationInput } from '../../common/utils/pagination.js';
import { storage } from '../../integrations/storage/index.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { processImage, sanitizeOriginalName } from './image-processing.js';
import { mediaUrl, toImageView, type MediaVariant } from './media.urls.js';
import type { MediaAssetView } from './media.schemas.js';

export interface UploadOptions {
  kind: MediaKind;
  visibility: MediaVisibility;
  altText?: string | undefined;
  uploadedById: string;
}

type MediaRow = Prisma.MediaAssetGetPayload<object>;

export function toMediaView(m: MediaRow): MediaAssetView {
  return {
    id: m.id,
    kind: m.kind,
    visibility: m.visibility,
    storageProvider: m.storageProvider,
    url: mediaUrl(m.id, m.storageKey, m.visibility),
    originalName: m.originalName,
    mimeType: m.mimeType,
    sizeBytes: m.sizeBytes,
    width: m.width,
    height: m.height,
    checksum: m.checksum,
    altText: m.altText,
    variants: toImageView(m)?.variants ?? {},
    uploadedById: m.uploadedById,
    orphanedAt: m.orphanedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

function storageKeys(m: { storageKey: string; variants: Prisma.JsonValue }): string[] {
  const variants = (m.variants ?? {}) as unknown as Record<string, MediaVariant>;
  return [m.storageKey, ...Object.values(variants).map((v) => v.key)];
}

const referenceCount = {
  moviePosters: true,
  movieBackdrops: true,
  seriesPosters: true,
  seriesBackdrops: true,
  seasonPosters: true,
  episodeStills: true,
  personPhotos: true,
  userAvatars: true,
  collectionCovers: true,
} as const;

export const mediaService = {
  async uploadImage(file: Express.Multer.File, options: UploadOptions): Promise<MediaAssetView> {
    const image = await processImage(file.buffer, file.mimetype);

    const now = new Date();
    const folder = `${options.visibility === 'PUBLIC' ? 'public' : 'private'}/images/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const id = randomUUID();
    const key = `${folder}/${id}.${image.extension}`;
    const variants: Record<string, MediaVariant> = {};
    const written: string[] = [];

    try {
      await storage.put(key, image.buffer, image.mimeType);
      written.push(key);
      for (const v of image.variants) {
        const vKey = `${folder}/${id}_${v.name}.webp`;
        await storage.put(vKey, v.buffer, 'image/webp');
        written.push(vKey);
        variants[v.name] = { key: vKey, width: v.width, height: v.height, sizeBytes: v.buffer.length };
      }

      const media = await prisma.mediaAsset.create({
        data: {
          id,
          kind: options.kind,
          visibility: options.visibility,
          storageProvider: storage.driver,
          storageKey: key,
          originalName: sanitizeOriginalName(file.originalname),
          mimeType: image.mimeType,
          sizeBytes: image.buffer.length,
          width: image.width,
          height: image.height,
          checksum: sha256Hex(image.buffer),
          variants: variants as unknown as Prisma.InputJsonValue,
          altText: options.altText ?? null,
          uploadedById: options.uploadedById,
        },
      });
      return toMediaView(media);
    } catch (err) {
      // Roll back files when the DB write fails so storage and DB stay consistent.
      await Promise.all(written.map((k) => storage.delete(k).catch(() => undefined)));
      throw err;
    }
  },

  async uploadMany(files: Express.Multer.File[], options: UploadOptions) {
    if (!files.length) throw AppError.upload('No files provided');
    const results: { originalName: string | null; media?: MediaAssetView; error?: string }[] = [];
    for (const file of files) {
      try {
        results.push({ originalName: sanitizeOriginalName(file.originalname), media: await this.uploadImage(file, options) });
      } catch (err) {
        results.push({
          originalName: sanitizeOriginalName(file.originalname),
          error: err instanceof AppError ? err.message : 'Upload failed',
        });
      }
    }
    return results;
  },

  async getById(id: string): Promise<MediaRow> {
    const media = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!media) throw AppError.notFound('Media');
    return media;
  },

  async list(query: PaginationInput & { kind?: MediaKind | undefined; orphaned?: boolean | undefined }) {
    const where: Prisma.MediaAssetWhereInput = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.orphaned === undefined ? {} : query.orphaned ? { orphanedAt: { not: null } } : { orphanedAt: null }),
    };
    const [items, total] = await prisma.$transaction([
      prisma.mediaAsset.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(query) }),
      prisma.mediaAsset.count({ where }),
    ]);
    return { items: items.map(toMediaView), meta: buildMeta(query, total) };
  },

  /** Lists entities that still reference this media file. */
  async references(id: string): Promise<{ type: string; id: string; label: string }[]> {
    const m = await prisma.mediaAsset.findUnique({
      where: { id },
      select: {
        moviePosters: { select: { id: true, title: true } },
        movieBackdrops: { select: { id: true, title: true } },
        seriesPosters: { select: { id: true, title: true } },
        seriesBackdrops: { select: { id: true, title: true } },
        seasonPosters: { select: { id: true, seasonNumber: true } },
        episodeStills: { select: { id: true, title: true } },
        personPhotos: { select: { id: true, name: true } },
        userAvatars: { select: { id: true, displayName: true } },
        collectionCovers: { select: { id: true, name: true } },
      },
    });
    if (!m) throw AppError.notFound('Media');
    return [
      ...m.moviePosters.map((x) => ({ type: 'movie.poster', id: x.id, label: x.title })),
      ...m.movieBackdrops.map((x) => ({ type: 'movie.backdrop', id: x.id, label: x.title })),
      ...m.seriesPosters.map((x) => ({ type: 'series.poster', id: x.id, label: x.title })),
      ...m.seriesBackdrops.map((x) => ({ type: 'series.backdrop', id: x.id, label: x.title })),
      ...m.seasonPosters.map((x) => ({ type: 'season.poster', id: x.id, label: `Season ${x.seasonNumber}` })),
      ...m.episodeStills.map((x) => ({ type: 'episode.still', id: x.id, label: x.title })),
      ...m.personPhotos.map((x) => ({ type: 'person.photo', id: x.id, label: x.name })),
      ...m.userAvatars.map((x) => ({ type: 'user.avatar', id: x.id, label: x.displayName })),
      ...m.collectionCovers.map((x) => ({ type: 'collection.cover', id: x.id, label: x.name })),
    ];
  },

  async isReferenced(id: string): Promise<boolean> {
    const m = await prisma.mediaAsset.findUnique({ where: { id }, select: { _count: { select: referenceCount } } });
    if (!m) return false;
    return Object.values(m._count).some((n) => n > 0);
  },

  /**
   * Deletes a media asset. Refuses while it is referenced (409 with the references) so posters
   * never silently disappear. DB row goes first; file removal failures are left for the orphan scanner.
   */
  async delete(id: string, actor: { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } }) {
    const media = await this.getById(id);
    const refs = await this.references(id);
    if (refs.length) {
      throw AppError.conflict(
        'Media is still in use. Replace these references first.',
        refs.map((r) => ({ path: r.type, message: `${r.label} (${r.id})` })),
      );
    }
    await prisma.mediaAsset.delete({ where: { id } });
    await this.deleteFiles(media);
    await writeAudit({
      actorId: actor.userId,
      action: 'media.delete',
      entityType: 'media',
      entityId: id,
      metadata: { storageKey: media.storageKey, checksum: media.checksum },
      client: actor.client,
    });
  },

  async deleteFiles(media: { storageKey: string; variants: Prisma.JsonValue }) {
    for (const key of storageKeys(media)) {
      await storage.delete(key).catch((err: Error) => logger.warn({ key, err: err.message }, 'Failed to delete media file'));
    }
  },

  /** Ensures a referenced media id exists (used by content services when attaching posters etc.). */
  async assertExists(id: string | null | undefined, field: string): Promise<void> {
    if (!id) return;
    const exists = await prisma.mediaAsset.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw AppError.validation([{ path: field, message: 'Media not found' }]);
  },

  /** Removes an unreferenced media asset (e.g. replaced avatar). Silent no-op when still referenced. */
  async deleteIfUnreferenced(id: string): Promise<void> {
    if (await this.isReferenced(id)) return;
    const media = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!media) return;
    await prisma.mediaAsset.delete({ where: { id } });
    await this.deleteFiles(media);
  },
};
