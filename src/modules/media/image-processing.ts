import sharp from 'sharp';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif';

export const ALLOWED_IMAGE_MIME = new Map<string, ImageFormat>([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif'],
]);

const FORMAT_MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};
const FORMAT_EXT: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };

/** Max decoded pixels — protects against decompression bombs (e.g. 1x1 MB file decoding to 20 GB). */
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_DIMENSION = 8000;

/**
 * Detects the real container format from magic bytes — the client-declared MIME type is never trusted.
 * SVG, GIF, HTML and anything else returns null.
 */
export function sniffImageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

export interface ProcessedImage {
  format: ImageFormat;
  mimeType: string;
  extension: string;
  buffer: Buffer;
  width: number;
  height: number;
  variants: { name: string; buffer: Buffer; width: number; height: number }[];
}

const VARIANT_WIDTHS: Record<string, number> = { sm: 320, md: 780, lg: 1280 };

/**
 * Validates and normalizes an uploaded image:
 *  - magic bytes must match the declared MIME type and an allowed format
 *  - sharp must fully decode it (rejects truncated/polyglot files)
 *  - EXIF orientation is applied, then ALL metadata (EXIF/GPS/ICC comments) is stripped by re-encoding
 *  - WebP variants are generated for responsive delivery
 */
export async function processImage(input: Buffer, declaredMime: string): Promise<ProcessedImage> {
  const declared = ALLOWED_IMAGE_MIME.get(declaredMime);
  const sniffed = sniffImageFormat(input);
  if (!declared || !sniffed) {
    throw AppError.upload('Only JPEG, PNG, WebP and AVIF images are allowed', ErrorCode.UNSUPPORTED_MEDIA_TYPE, 415);
  }
  if (declared !== sniffed) {
    throw AppError.upload('File content does not match its declared type', ErrorCode.UNSUPPORTED_MEDIA_TYPE, 415);
  }

  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  } catch {
    throw AppError.upload('Image could not be decoded', ErrorCode.UNSUPPORTED_MEDIA_TYPE, 415);
  }
  const decodedFormat = meta.format === 'heif' ? 'avif' : meta.format;
  if (decodedFormat !== sniffed || !meta.width || !meta.height) {
    throw AppError.upload('Image could not be decoded', ErrorCode.UNSUPPORTED_MEDIA_TYPE, 415);
  }
  if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) {
    throw AppError.upload(`Image dimensions must not exceed ${MAX_DIMENSION}px`);
  }

  const base = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
  let pipeline = base();
  switch (sniffed) {
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality: 86, mozjpeg: true });
      break;
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 9 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: 86 });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality: 60 });
      break;
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  const variants: ProcessedImage['variants'] = [];
  for (const [name, width] of Object.entries(VARIANT_WIDTHS)) {
    if (info.width <= width) continue;
    const out = await base().resize({ width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    variants.push({ name, buffer: out.data, width: out.info.width, height: out.info.height });
  }

  return {
    format: sniffed,
    mimeType: FORMAT_MIME[sniffed],
    extension: FORMAT_EXT[sniffed],
    buffer: data,
    width: info.width,
    height: info.height,
    variants,
  };
}

/** Display-only filename: strips any path and unsafe characters. Never used to build storage paths. */
export function sanitizeOriginalName(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').slice(0, 200).trim();
  return cleaned || null;
}
