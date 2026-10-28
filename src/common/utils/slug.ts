import { randomBytes } from 'node:crypto';

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ʻʼ‘’'`]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

/**
 * Returns a slug that is unique according to `exists`. Appends a short random suffix on collision.
 */
export async function uniqueSlug(base: string, exists: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base) || 'item';
  if (!(await exists(root))) return root;
  for (let i = 0; i < 5; i++) {
    const candidate = `${root}-${randomBytes(3).toString('hex')}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${root}-${randomBytes(8).toString('hex')}`;
}
