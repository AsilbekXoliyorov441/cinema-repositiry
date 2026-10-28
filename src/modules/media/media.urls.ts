import { env } from '../../config/env.js';
import { storage } from '../../integrations/storage/index.js';

export interface MediaVariant {
  key: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface MediaLike {
  id: string;
  storageKey: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  width: number;
  height: number;
  variants?: unknown;
  altText?: string | null;
}

export interface ImageView {
  id: string;
  url: string;
  width: number;
  height: number;
  alt: string | null;
  variants: Record<string, { url: string; width: number; height: number }>;
}

/** Single place that turns stored media into client URLs (public CDN/static or authenticated API route). */
export function mediaUrl(id: string, key: string, visibility: 'PUBLIC' | 'PRIVATE'): string {
  if (visibility === 'PUBLIC') {
    const url = storage.publicUrl(key);
    if (url) return url;
  }
  return `${env.APP_URL}${env.API_PREFIX}/media/${id}/content`;
}

export function toImageView(media: MediaLike | null | undefined): ImageView | null {
  if (!media) return null;
  const variants: ImageView['variants'] = {};
  const raw = (media.variants ?? {}) as Record<string, MediaVariant>;
  for (const [name, v] of Object.entries(raw)) {
    variants[name] = {
      url: media.visibility === 'PUBLIC' ? (storage.publicUrl(v.key) ?? mediaUrl(media.id, media.storageKey, media.visibility)) : `${mediaUrl(media.id, media.storageKey, media.visibility)}?variant=${name}`,
      width: v.width,
      height: v.height,
    };
  }
  return {
    id: media.id,
    url: mediaUrl(media.id, media.storageKey, media.visibility),
    width: media.width,
    height: media.height,
    alt: media.altText ?? null,
    variants,
  };
}

/** Prisma select for embedding images in responses. */
export const imageSelect = {
  id: true,
  storageKey: true,
  visibility: true,
  width: true,
  height: true,
  variants: true,
  altText: true,
} as const;
