import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { uniqueSlug } from '../../common/utils/slug.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { mediaService } from '../media/media.service.js';
import { imageSelect, toImageView } from '../media/media.urls.js';
import { toMovieSummary } from '../movies/movies.mapper.js';
import { movieSummarySelect, publicListWhere } from '../movies/movies.repository.js';
import type { z } from 'zod';
import type { collectionBody, updateCollectionBody } from './collections.schemas.js';

type Actor = { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } };

function include(publicOnly: boolean) {
  return {
    cover: { select: imageSelect },
    movies: {
      where: publicOnly ? { movie: publicListWhere() } : { movie: { deletedAt: null } },
      orderBy: { position: 'asc' as const },
      select: { movie: { select: movieSummarySelect } },
    },
  } satisfies Prisma.CollectionInclude;
}
type Row = Prisma.CollectionGetPayload<{ include: ReturnType<typeof include> }>;

function toView(c: Row) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    cover: toImageView(c.cover),
    movieCount: c.movies.length,
    movies: c.movies.map((m) => toMovieSummary(m.movie)),
    status: c.status,
    sortOrder: c.sortOrder,
  };
}

export const collectionsService = {
  list() {
    return cache.wrap(CacheNamespace.CATALOG, 'collections', 300, async () => {
      const rows = await prisma.collection.findMany({ where: { status: 'PUBLISHED' }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: include(true) });
      return rows.map((c) => {
        const { movies: _movies, status: _s, sortOrder: _o, ...summary } = toView(c);
        return summary;
      });
    });
  },

  async getPublic(slug: string) {
    const c = await prisma.collection.findFirst({ where: { slug, status: 'PUBLISHED' }, include: include(true) });
    if (!c) throw AppError.notFound('Collection');
    const { status: _s, sortOrder: _o, ...view } = toView(c);
    return view;
  },

  async adminList() {
    const rows = await prisma.collection.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: include(false) });
    return rows.map(toView);
  },

  async adminGet(id: string) {
    const c = await prisma.collection.findUnique({ where: { id }, include: include(false) });
    if (!c) throw AppError.notFound('Collection');
    return toView(c);
  },

  async create(input: z.infer<typeof collectionBody>, actor: Actor) {
    await mediaService.assertExists(input.coverMediaId, 'coverMediaId');
    const slug = input.slug ?? (await uniqueSlug(input.name, async (s) => Boolean(await prisma.collection.findUnique({ where: { slug: s } }))));
    const c = await prisma.collection.create({ data: { ...input, slug } });
    await writeAudit({ actorId: actor.userId, action: 'collection.create', entityType: 'collection', entityId: c.id, client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
    return this.adminGet(c.id);
  },

  async update(id: string, input: z.infer<typeof updateCollectionBody>, actor: Actor) {
    await this.adminGet(id);
    await mediaService.assertExists(input.coverMediaId, 'coverMediaId');
    await prisma.collection.update({ where: { id }, data: input });
    await writeAudit({ actorId: actor.userId, action: 'collection.update', entityType: 'collection', entityId: id, client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
    return this.adminGet(id);
  },

  async setMovies(id: string, movieIds: string[], actor: Actor) {
    await this.adminGet(id);
    const unique = [...new Set(movieIds)];
    const found = await prisma.movie.count({ where: { id: { in: unique }, deletedAt: null } });
    if (found !== unique.length) throw AppError.validation([{ path: 'movieIds', message: 'One or more movies do not exist' }]);
    await prisma.$transaction([
      prisma.collectionMovie.deleteMany({ where: { collectionId: id } }),
      prisma.collectionMovie.createMany({ data: unique.map((movieId, position) => ({ collectionId: id, movieId, position })) }),
    ]);
    await writeAudit({ actorId: actor.userId, action: 'collection.set_movies', entityType: 'collection', entityId: id, client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
    return this.adminGet(id);
  },

  async remove(id: string, actor: Actor) {
    await this.adminGet(id);
    await prisma.collection.delete({ where: { id } });
    await writeAudit({ actorId: actor.userId, action: 'collection.delete', entityType: 'collection', entityId: id, client: actor.client });
    await cache.invalidate(CacheNamespace.CATALOG);
  },
};
