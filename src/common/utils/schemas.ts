import { z } from 'zod';

export const uuid = z.uuid();
export const idParam = z.object({ id: z.uuid() });
export const slugOrIdParam = z.object({ idOrSlug: z.string().min(1).max(280) });

export const isoDate = z.iso.date();
export const isoDateTime = z.iso.datetime({ offset: true });

/** Query date range used by admin analytics and lists. */
export const dateRangeQuery = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '`from` must be before `to`', path: ['from'] });

export const languageCode = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'ISO 639-1 language code, e.g. "en" or "uz"');
export const countryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 country code, e.g. "US"')
  .transform((v) => v.toUpperCase());
export const currencyCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'ISO 4217 currency code')
  .transform((v) => v.toUpperCase());

export const booleanQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const csvQuery = z
  .string()
  .max(500)
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .optional();

export const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) });

/** Generic success envelope schema for docs. */
export const messageOnly = z.object({ message: z.string() });
