import { z } from 'zod';

export const CONTENT_STATUS = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const VISIBILITY = ['PUBLIC', 'UNLISTED', 'PRIVATE'] as const;
export const ACCESS_TIER = ['FREE', 'PRO'] as const;
export const AGE_RATING = ['ALL', 'AGE_6', 'AGE_12', 'AGE_16', 'AGE_18'] as const;
export const CREW_JOB = ['DIRECTOR', 'WRITER', 'PRODUCER', 'COMPOSER', 'CINEMATOGRAPHER', 'EDITOR', 'OTHER'] as const;

export const externalIdsSchema = z
  .object({
    tmdb: z.string().max(50).optional(),
    imdb: z
      .string()
      .regex(/^tt\d{5,10}$/)
      .optional(),
  })
  .strict();

export const slugInput = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, digits and dashes')
  .max(200);

/** Prisma filter: content visible to the public catalog right now. */
export function publicContentWhere(now = new Date()) {
  return {
    status: 'PUBLISHED' as const,
    deletedAt: null,
    publishedAt: { lte: now },
  };
}

export const genreRefSchema = z.object({ id: z.uuid(), name: z.string(), slug: z.string() });
