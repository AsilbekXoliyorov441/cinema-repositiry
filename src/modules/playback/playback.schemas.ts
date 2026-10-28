import { z } from 'zod';
import { embedUrl, externalMediaUrl } from '../../common/utils/url-safety.js';
import { languageCode } from '../../common/utils/schemas.js';

export const VIDEO_PROVIDERS = ['EXTERNAL', 'SIGNED_CDN', 'YOUTUBE', 'VIMEO'] as const;
export const VIDEO_ASSET_TYPES = ['FEATURE', 'TRAILER', 'TEASER', 'EXTRA'] as const;
export const MANIFEST_TYPES = ['MP4', 'HLS', 'DASH', 'EMBED'] as const;

const videoFields = z.object({
  provider: z.enum(VIDEO_PROVIDERS),
  assetType: z.enum(VIDEO_ASSET_TYPES).default('FEATURE'),
  playbackUrl: z.string().max(2048),
  manifestType: z.enum(MANIFEST_TYPES),
  qualityLabel: z
    .string()
    .regex(/^(\d{3,4}p|4K|8K|SD|HD|AUTO)$/i)
    .nullable()
    .optional(),
  language: languageCode.nullable().optional(),
  isDefault: z.boolean().default(false),
  requiresSigning: z.boolean().default(false),
  premiumOnly: z.boolean().default(false).describe('Only plans with HD_QUALITY receive this source'),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

/** Cross-field validation: embeds only from allowlisted hosts, files/manifests only from public https hosts. */
function refineVideo<T extends z.ZodType<Partial<z.infer<typeof videoFields>>>>(schema: T) {
  return schema.superRefine((v, ctx) => {
    if (v.playbackUrl === undefined) return;
    const isEmbed = v.manifestType === 'EMBED';
    const check = (isEmbed ? embedUrl : externalMediaUrl).safeParse(v.playbackUrl);
    if (!check.success) {
      for (const issue of check.error.issues) ctx.addIssue({ code: 'custom', path: ['playbackUrl'], message: issue.message });
    }
    if (isEmbed && v.provider && !['YOUTUBE', 'VIMEO'].includes(v.provider)) {
      ctx.addIssue({ code: 'custom', path: ['provider'], message: 'EMBED manifests require provider YOUTUBE or VIMEO' });
    }
    if (v.requiresSigning && v.provider && v.provider !== 'SIGNED_CDN') {
      ctx.addIssue({ code: 'custom', path: ['requiresSigning'], message: 'Only SIGNED_CDN sources can be signed' });
    }
  });
}

export const createVideoBody = refineVideo(videoFields);
export const updateVideoBody = refineVideo(videoFields.partial());

export const subtitleBody = z.object({
  language: languageCode,
  label: z.string().trim().min(1).max(80),
  url: externalMediaUrl.refine((u) => /\.vtt(\?|$)/i.test(u), 'Subtitles must be WebVTT (.vtt)'),
  isDefault: z.boolean().default(false),
});

export const videoAssetSchema = z.object({
  id: z.uuid(),
  movieId: z.uuid().nullable(),
  episodeId: z.uuid().nullable(),
  provider: z.enum(VIDEO_PROVIDERS),
  assetType: z.enum(VIDEO_ASSET_TYPES),
  playbackUrl: z.string(),
  manifestType: z.enum(MANIFEST_TYPES),
  qualityLabel: z.string().nullable(),
  language: z.string().nullable(),
  isDefault: z.boolean(),
  requiresSigning: z.boolean(),
  premiumOnly: z.boolean(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  lastCheckedAt: z.string().nullable(),
  lastCheckStatus: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const subtitleSchema = z.object({
  id: z.uuid(),
  language: z.string(),
  label: z.string(),
  url: z.string(),
  isDefault: z.boolean(),
});

export const playbackResponseSchema = z.object({
  contentType: z.enum(['movie', 'episode']),
  contentId: z.uuid(),
  title: z.string(),
  accessTier: z.enum(['FREE', 'PRO']),
  durationSeconds: z.number().int().nullable(),
  sources: z.array(
    z.object({
      id: z.uuid(),
      type: z.enum(MANIFEST_TYPES),
      provider: z.enum(VIDEO_PROVIDERS),
      url: z.string(),
      quality: z.string().nullable(),
      language: z.string().nullable(),
      isDefault: z.boolean(),
      expiresAt: z.string().nullable().describe('Set when the URL is time-limited (signed)'),
    }),
  ),
  subtitles: z.array(subtitleSchema),
  resume: z.object({ positionSeconds: z.number().int(), completed: z.boolean() }).nullable(),
});
export type PlaybackResponse = z.infer<typeof playbackResponseSchema>;
