import { z } from 'zod';
import { externalIdsSchema, slugInput } from '../../common/utils/content.js';
import { paginationQuery } from '../../common/utils/pagination.js';
import { searchTerm } from '../../common/utils/search.js';
import { imageViewSchema } from '../media/media.schemas.js';

export const personBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugInput.optional(),
  biography: z.string().trim().max(10_000).nullable().optional(),
  birthDate: z.iso.date().nullable().optional(),
  deathDate: z.iso.date().nullable().optional(),
  birthPlace: z.string().trim().max(200).nullable().optional(),
  photoMediaId: z.uuid().nullable().optional(),
  externalIds: externalIdsSchema.nullable().optional(),
});
export const updatePersonBody = personBody.partial();

export const listPeopleQuery = paginationQuery.extend({ q: searchTerm });

export const personSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  photo: imageViewSchema.nullable(),
});

export const personDetailSchema = personSummarySchema.extend({
  biography: z.string().nullable(),
  birthDate: z.string().nullable(),
  deathDate: z.string().nullable(),
  birthPlace: z.string().nullable(),
  credits: z.object({
    cast: z.array(z.object({ movieId: z.uuid(), slug: z.string(), title: z.string(), releaseYear: z.number().nullable(), characterName: z.string().nullable() })),
    crew: z.array(z.object({ movieId: z.uuid(), slug: z.string(), title: z.string(), releaseYear: z.number().nullable(), job: z.string() })),
  }),
});
