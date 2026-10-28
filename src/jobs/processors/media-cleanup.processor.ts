import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { addMs } from '../../common/utils/duration.js';
import { storage } from '../../integrations/storage/index.js';
import { mediaService } from '../../modules/media/media.service.js';
import type { MediaVariant } from '../../modules/media/media.urls.js';

const unreferenced = {
  moviePosters: { none: {} },
  movieBackdrops: { none: {} },
  seriesPosters: { none: {} },
  seriesBackdrops: { none: {} },
  seasonPosters: { none: {} },
  episodeStills: { none: {} },
  personPhotos: { none: {} },
  userAvatars: { none: {} },
  collectionCovers: { none: {} },
} as const;

/**
 * Orphan media handling (idempotent):
 *  1. DB records unreferenced for longer than the grace period are flagged `orphanedAt`; referenced ones are unflagged.
 *  2. With ORPHAN_MEDIA_AUTO_DELETE=true, records flagged for longer than the grace period are deleted (DB + files).
 *  3. Files on disk without a DB record (e.g. failed deletes) older than the grace period are removed (auto-delete) or reported.
 */
export async function processOrphanMedia(now = new Date()) {
  const grace = addMs(now, -env.ORPHAN_MEDIA_GRACE_HOURS * 3_600_000);

  const flagged = await prisma.mediaAsset.updateMany({ where: { orphanedAt: null, createdAt: { lt: grace }, ...unreferenced }, data: { orphanedAt: now } });
  await prisma.mediaAsset.updateMany({ where: { orphanedAt: { not: null }, NOT: unreferenced }, data: { orphanedAt: null } });

  let deleted = 0;
  if (env.ORPHAN_MEDIA_AUTO_DELETE) {
    const stale = await prisma.mediaAsset.findMany({ where: { orphanedAt: { lt: grace } }, select: { id: true }, take: 500 });
    for (const m of stale) {
      await mediaService.deleteIfUnreferenced(m.id);
      deleted++;
    }
  }

  // Filesystem scan: collect every key the database knows about (originals + variants).
  const known = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.mediaAsset.findMany({ select: { id: true, storageKey: true, variants: true }, orderBy: { id: 'asc' }, take: 1000, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
    if (!batch.length) break;
    for (const m of batch) {
      known.add(m.storageKey);
      for (const v of Object.values((m.variants ?? {}) as unknown as Record<string, MediaVariant>)) known.add(v.key);
    }
    cursor = batch[batch.length - 1]?.id;
  }
  let strayFiles = 0;
  for await (const obj of storage.listObjects()) {
    if (known.has(obj.key) || obj.lastModified > grace) continue;
    strayFiles++;
    if (env.ORPHAN_MEDIA_AUTO_DELETE) await storage.delete(obj.key);
  }
  logger.info({ flagged: flagged.count, deleted, strayFiles, autoDelete: env.ORPHAN_MEDIA_AUTO_DELETE }, 'Orphan media scan finished');
  return { flagged: flagged.count, deleted, strayFiles };
}
