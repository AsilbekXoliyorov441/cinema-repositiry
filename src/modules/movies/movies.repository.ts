import { containsInsensitive } from '../../common/utils/search.js';
import type { Prisma } from '@prisma/client';
import { prisma, type DbOrTx } from '../../config/database.js';
import { publicContentWhere } from '../../common/utils/content.js';
import { imageSelect } from '../media/media.urls.js';
import type { ListMoviesQuery } from './movies.schemas.js';

export const movieSummarySelect = {
  id: true,
  slug: true,
  title: true,
  originalTitle: true,
  releaseYear: true,
  durationMinutes: true,
  ageRating: true,
  accessTier: true,
  language: true,
  country: true,
  featured: true,
  ratingAvg: true,
  ratingCount: true,
  poster: { select: imageSelect },
  backdrop: { select: imageSelect },
  genres: { select: { genre: { select: { id: true, name: true, slug: true } } } },
} satisfies Prisma.MovieSelect;

export const movieDetailInclude = {
  poster: { select: imageSelect },
  backdrop: { select: imageSelect },
  genres: { select: { genre: { select: { id: true, name: true, slug: true } } } },
  cast: {
    where: { person: { deletedAt: null } },
    orderBy: { order: 'asc' },
    select: { characterName: true, order: true, person: { select: { id: true, name: true, slug: true, photo: { select: imageSelect } } } },
  },
  crew: {
    where: { person: { deletedAt: null } },
    select: { job: true, jobTitle: true, person: { select: { id: true, name: true, slug: true, photo: { select: imageSelect } } } },
  },
  videos: { where: { status: 'ACTIVE', assetType: 'FEATURE' }, select: { qualityLabel: true } },
} satisfies Prisma.MovieInclude;

export type MovieSummaryRow = Prisma.MovieGetPayload<{ select: typeof movieSummarySelect }>;
export type MovieDetailRow = Prisma.MovieGetPayload<{ include: typeof movieDetailInclude }>;

/** Publicly listable movies (UNLISTED are reachable by direct link only). */
export function publicListWhere(): Prisma.MovieWhereInput {
  return { ...publicContentWhere(), visibility: 'PUBLIC' };
}

export function buildPublicWhere(q: Partial<ListMoviesQuery>): Prisma.MovieWhereInput {
  const and: Prisma.MovieWhereInput[] = [publicListWhere()];
  if (q.q) {
    and.push({
      OR: [
        { title: containsInsensitive(q.q) },
        { originalTitle: containsInsensitive(q.q) },
      ],
    });
  }
  if (q.genre) and.push({ genres: { some: { genre: { slug: q.genre } } } });
  if (q.year) and.push({ releaseYear: q.year });
  if (q.yearFrom || q.yearTo) and.push({ releaseYear: { gte: q.yearFrom, lte: q.yearTo } });
  if (q.country) and.push({ country: q.country });
  if (q.language) and.push({ language: q.language });
  if (q.ageRating?.length) and.push({ ageRating: { in: q.ageRating } });
  if (q.accessTier) and.push({ accessTier: q.accessTier });
  return { AND: and };
}

const SORT_MAP: Record<string, (dir: 'asc' | 'desc') => Prisma.MovieOrderByWithRelationInput[]> = {
  publishedAt: (dir) => [{ publishedAt: dir }, { id: 'asc' }],
  releaseDate: (dir) => [{ releaseDate: { sort: dir, nulls: 'last' } }, { id: 'asc' }],
  title: (dir) => [{ title: dir }, { id: 'asc' }],
  rating: (dir) => [{ ratingAvg: dir }, { ratingCount: dir }, { id: 'asc' }],
  popularity: (dir) => [{ popularityScore: dir }, { id: 'asc' }],
};

export function movieOrderBy(sort: { field: string; direction: 'asc' | 'desc' }): Prisma.MovieOrderByWithRelationInput[] {
  return (SORT_MAP[sort.field] ?? SORT_MAP.publishedAt!)(sort.direction);
}

export const moviesRepository = {
  async findPage(where: Prisma.MovieWhereInput, orderBy: Prisma.MovieOrderByWithRelationInput[], skip: number, take: number) {
    const [rows, total] = await prisma.$transaction([
      prisma.movie.findMany({ where, orderBy, skip, take, select: movieSummarySelect }),
      prisma.movie.count({ where }),
    ]);
    return { rows, total };
  },

  findMany(where: Prisma.MovieWhereInput, orderBy: Prisma.MovieOrderByWithRelationInput[], take: number) {
    return prisma.movie.findMany({ where, orderBy, take, select: movieSummarySelect });
  },

  findPublicDetail(idOrSlug: string) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    return prisma.movie.findFirst({
      where: { ...publicContentWhere(), visibility: { in: ['PUBLIC', 'UNLISTED'] }, ...(isUuid ? { id: idOrSlug } : { slug: idOrSlug }) },
      include: movieDetailInclude,
    });
  },

  findAdminDetail(id: string) {
    return prisma.movie.findUnique({ where: { id }, include: movieDetailInclude });
  },

  async slugExists(slug: string, db: DbOrTx = prisma): Promise<boolean> {
    return Boolean(await db.movie.findUnique({ where: { slug }, select: { id: true } }));
  },
};
