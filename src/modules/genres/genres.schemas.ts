import { z } from 'zod';
import { slugInput } from '../../common/utils/content.js';

export const genreBody = z.object({ name: z.string().trim().min(2).max(80), slug: slugInput.optional() });
export const updateGenreBody = genreBody.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const genreSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  movieCount: z.number().int(),
});
