import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { publicContentWhere } from '../../common/utils/content.js';
import { slugify } from '../../common/utils/slug.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import type { z } from 'zod';
import type { genreBody, updateGenreBody } from './genres.schemas.js';

type Actor = { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } };

export const genresService = {
  /** Public list with counts of publicly visible movies. Cached; invalidated on any genre/movie change. */
  listPublic() {
    return cache.wrap(CacheNamespace.GENRES, 'all', 3600, async () => {
      const genres = await prisma.genre.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          slug: true,
          _count: { select: { movies: { where: { movie: { ...publicContentWhere(), visibility: 'PUBLIC' } } } } },
        },
      });
      return genres.map((g) => ({ id: g.id, name: g.name, slug: g.slug, movieCount: g._count.movies }));
    });
  },

  async getBySlug(slug: string) {
    const genre = await prisma.genre.findUnique({ where: { slug }, select: { id: true, name: true, slug: true } });
    if (!genre) throw AppError.notFound('Genre');
    return genre;
  },

  async create(input: z.infer<typeof genreBody>, actor: Actor) {
    const genre = await prisma.genre.create({ data: { name: input.name, slug: input.slug ?? slugify(input.name) } });
    await cache.invalidate(CacheNamespace.GENRES, CacheNamespace.CATALOG);
    await writeAudit({ actorId: actor.userId, action: 'genre.create', entityType: 'genre', entityId: genre.id, client: actor.client });
    return { ...genre, movieCount: 0 };
  },

  async update(id: string, input: z.infer<typeof updateGenreBody>, actor: Actor) {
    const genre = await prisma.genre.update({ where: { id }, data: input, include: { _count: { select: { movies: true } } } });
    await cache.invalidate(CacheNamespace.GENRES, CacheNamespace.CATALOG);
    await writeAudit({ actorId: actor.userId, action: 'genre.update', entityType: 'genre', entityId: id, metadata: input, client: actor.client });
    return { id: genre.id, name: genre.name, slug: genre.slug, movieCount: genre._count.movies };
  },

  async remove(id: string, actor: Actor) {
    await prisma.genre.delete({ where: { id } });
    await cache.invalidate(CacheNamespace.GENRES, CacheNamespace.CATALOG);
    await writeAudit({ actorId: actor.userId, action: 'genre.delete', entityType: 'genre', entityId: id, client: actor.client });
  },
};
