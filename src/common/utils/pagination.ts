import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

export type PaginationInput = z.infer<typeof paginationQuery>;

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface Paginated<T> {
  items: T[];
  meta: PaginationMeta;
}

export function toSkipTake({ page, limit }: PaginationInput): { skip: number; take: number } {
  return { skip: (page - 1) * limit, take: limit };
}

export function buildMeta({ page, limit }: PaginationInput, total: number): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 };
}

export function paginated<T>(items: T[], input: PaginationInput, total: number): Paginated<T> {
  return { items, meta: buildMeta(input, total) };
}

/**
 * Builds a strict sort schema from an allowlist of field names.
 * Accepts `sort=field` or `sort=-field` (descending).
 */
export function sortQuery<const F extends readonly [string, ...string[]]>(fields: F, fallback: `${'' | '-'}${F[number]}`) {
  const values = fields.flatMap((f) => [f, `-${f}`]) as [string, ...string[]];
  return z
    .enum(values)
    .default(fallback)
    .transform((v) => {
      const desc = v.startsWith('-');
      return { field: (desc ? v.slice(1) : v) as F[number], direction: desc ? ('desc' as const) : ('asc' as const) };
    });
}
