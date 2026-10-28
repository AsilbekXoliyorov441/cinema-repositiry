import { containsInsensitive } from '../../common/utils/search.js';
import { Prisma } from '@prisma/client';
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
import type { listPeopleQuery, personBody, updatePersonBody } from './people.schemas.js';

type Actor = { userId: string; client?: { ip?: string | undefined; userAgent?: string | undefined } };

const date = (d: string | null | undefined) => (d === undefined ? undefined : d === null ? null : new Date(d));
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function toData(input: z.infer<typeof updatePersonBody>) {
  return {
    name: input.name,
    biography: input.biography,
    birthDate: date(input.birthDate),
    deathDate: date(input.deathDate),
    birthPlace: input.birthPlace,
    photoMediaId: input.photoMediaId,
    // Prisma requires the DbNull sentinel to store SQL NULL in Json columns.
    externalIds: input.externalIds === null ? Prisma.DbNull : input.externalIds,
  };
}

export const peopleService = {
  async list(query: z.infer<typeof listPeopleQuery>) {
    const where: Prisma.PersonWhereInput = {
      deletedAt: null,
      ...(query.q ? { name: containsInsensitive(query.q) } : {}),
    };
    const [rows, total] = await prisma.$transaction([
      prisma.person.findMany({
        where,
        orderBy: { name: 'asc' },
        select: { id: true, name: true, slug: true, photo: { select: imageSelect } },
        ...toSkipTake(query),
      }),
      prisma.person.count({ where }),
    ]);
    return { items: rows.map((p) => ({ ...p, photo: toImageView(p.photo) })), meta: buildMeta(query, total) };
  },

  async get(idOrSlug: string) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const visibleMovie = { ...publicContentWhere(), visibility: { in: ['PUBLIC', 'UNLISTED'] as ('PUBLIC' | 'UNLISTED')[] } };
    const person = await prisma.person.findFirst({
      where: { deletedAt: null, ...(isUuid ? { id: idOrSlug } : { slug: idOrSlug }) },
      include: {
        photo: { select: imageSelect },
        cast: {
          where: { movie: visibleMovie },
          include: { movie: { select: { id: true, slug: true, title: true, releaseYear: true } } },
          orderBy: { movie: { releaseDate: 'desc' } },
        },
        crew: {
          where: { movie: visibleMovie },
          include: { movie: { select: { id: true, slug: true, title: true, releaseYear: true } } },
          orderBy: { movie: { releaseDate: 'desc' } },
        },
      },
    });
    if (!person) throw AppError.notFound('Person');
    return {
      id: person.id,
      name: person.name,
      slug: person.slug,
      photo: toImageView(person.photo),
      biography: person.biography,
      birthDate: iso(person.birthDate),
      deathDate: iso(person.deathDate),
      birthPlace: person.birthPlace,
      credits: {
        cast: person.cast.map((c) => ({ movieId: c.movie.id, slug: c.movie.slug, title: c.movie.title, releaseYear: c.movie.releaseYear, characterName: c.characterName })),
        crew: person.crew.map((c) => ({ movieId: c.movie.id, slug: c.movie.slug, title: c.movie.title, releaseYear: c.movie.releaseYear, job: c.job })),
      },
    };
  },

  async create(input: z.infer<typeof personBody>, actor: Actor) {
    await mediaService.assertExists(input.photoMediaId, 'photoMediaId');
    const slug = input.slug ?? (await uniqueSlug(input.name, async (s) => Boolean(await prisma.person.findUnique({ where: { slug: s } }))));
    const person = await prisma.person.create({ data: { ...toData(input), name: input.name, slug } });
    await writeAudit({ actorId: actor.userId, action: 'person.create', entityType: 'person', entityId: person.id, client: actor.client });
    return this.get(person.id);
  },

  async update(id: string, input: z.infer<typeof updatePersonBody>, actor: Actor) {
    await this.assertExists(id);
    await mediaService.assertExists(input.photoMediaId, 'photoMediaId');
    await prisma.person.update({ where: { id }, data: { ...toData(input), slug: input.slug } });
    await cache.invalidate(CacheNamespace.CATALOG);
    await writeAudit({ actorId: actor.userId, action: 'person.update', entityType: 'person', entityId: id, client: actor.client });
    return this.get(id);
  },

  async remove(id: string, actor: Actor) {
    await this.assertExists(id);
    // Soft delete keeps credits history; the person disappears from public endpoints.
    await prisma.person.update({ where: { id }, data: { deletedAt: new Date() } });
    await cache.invalidate(CacheNamespace.CATALOG);
    await writeAudit({ actorId: actor.userId, action: 'person.delete', entityType: 'person', entityId: id, client: actor.client });
  },

  async assertExists(id: string) {
    const exists = await prisma.person.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!exists) throw AppError.notFound('Person');
  },
};
