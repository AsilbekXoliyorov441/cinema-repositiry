import multer from 'multer';
import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { ALLOWED_IMAGE_MIME } from './image-processing.js';

/**
 * Multer keeps uploads in memory (bounded by fileSize × files) so nothing touches disk before
 * validation. Files are written to storage only after content sniffing and re-encoding.
 */
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.floor(env.MAX_IMAGE_SIZE_MB * 1024 * 1024),
    files: env.MAX_BULK_UPLOAD_FILES,
    fields: 10,
    fieldSize: 10 * 1024,
    parts: env.MAX_BULK_UPLOAD_FILES + 10,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      cb(AppError.upload('Only JPEG, PNG, WebP and AVIF images are allowed', ErrorCode.UNSUPPORTED_MEDIA_TYPE, 415));
      return;
    }
    cb(null, true);
  },
});

export const singleImage = imageUpload.single('file');
export const multipleImages = imageUpload.array('files', env.MAX_BULK_UPLOAD_FILES);

export const singleImageDoc = {
  type: 'object',
  required: ['file'],
  properties: {
    file: { type: 'string', format: 'binary', description: `JPEG, PNG, WebP or AVIF, max ${env.MAX_IMAGE_SIZE_MB} MB` },
    kind: { type: 'string', enum: ['POSTER', 'BACKDROP', 'PERSON_PHOTO', 'SERIES_IMAGE', 'EPISODE_STILL', 'AVATAR', 'COLLECTION_COVER', 'OTHER'] },
    visibility: { type: 'string', enum: ['PUBLIC', 'PRIVATE'] },
    altText: { type: 'string', maxLength: 300 },
  },
};

export const multipleImagesDoc = {
  type: 'object',
  required: ['files'],
  properties: {
    files: { type: 'array', items: { type: 'string', format: 'binary' }, maxItems: env.MAX_BULK_UPLOAD_FILES },
    kind: singleImageDoc.properties.kind,
    visibility: singleImageDoc.properties.visibility,
  },
};
