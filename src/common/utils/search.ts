import { z } from 'zod';

/** Escapes LIKE/ILIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Search term: trimmed, collapsed whitespace, bounded length.
 * Prisma parameterizes queries, so this guards against wildcard abuse and oversized scans, not SQL injection.
 */
export const searchTerm = z
  .string()
  .trim()
  .max(100)
  .transform((v) => v.replace(/\s+/g, ' '))
  .refine((v) => v.length === 0 || v.length >= 2, 'Search term must be at least 2 characters')
  .optional()
  .transform((v) => (v ? v : undefined));

/**
 * Case-insensitive substring filter. Prisma passes `contains` values straight into ILIKE without
 * escaping `%` and `_`, so the term is escaped here — otherwise `q=%%` would match every row.
 */
export function containsInsensitive(term: string) {
  return { contains: escapeLike(term), mode: 'insensitive' as const };
}
