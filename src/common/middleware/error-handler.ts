import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { AppError, ErrorCode, type ErrorDetail } from '../errors/app-error.js';
import { isProduction } from '../../config/env.js';
import { logger } from '../../config/logger.js';

interface ErrorBody {
  success: false;
  message: string;
  error: { code: string; details: ErrorDetail[]; stack?: string };
  requestId?: string;
}

function fromPrisma(err: Prisma.PrismaClientKnownRequestError): AppError {
  switch (err.code) {
    case 'P2002': {
      const target = (err.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target : [target];
      return AppError.conflict('A record with the same unique value already exists', fields.map((f) => ({ path: f, message: 'must be unique' })));
    }
    case 'P2025':
      return AppError.notFound('Record');
    case 'P2003':
      return AppError.conflict('Operation violates a relation constraint');
    case 'P2034':
      return AppError.conflict('Concurrent update detected, please retry');
    default:
      return new AppError(500, ErrorCode.DATABASE_ERROR, 'Database operation failed');
  }
}

function fromMulter(err: multer.MulterError): AppError {
  if (err.code === 'LIMIT_FILE_SIZE') return AppError.upload('File is too large', ErrorCode.PAYLOAD_TOO_LARGE, 413);
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return AppError.upload(`Unexpected or too many files (${err.field ?? 'file'})`);
  }
  return AppError.upload(err.message);
}

function normalize(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Prisma.PrismaClientKnownRequestError) return fromPrisma(err);
  if (err instanceof Prisma.PrismaClientValidationError) {
    return new AppError(500, ErrorCode.DATABASE_ERROR, 'Database query was invalid');
  }
  if (err instanceof multer.MulterError) return fromMulter(err);
  if (typeof err === 'object' && err !== null && 'type' in err) {
    const type = (err as { type: string }).type;
    if (type === 'entity.parse.failed') return AppError.badRequest('Malformed JSON body');
    if (type === 'entity.too.large') return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Request body too large');
  }
  // http-errors style (express.static, body-parser): trust only 4xx statuses
  if (typeof err === 'object' && err !== null) {
    const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return new AppError(status, status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.BAD_REQUEST, status === 404 ? 'Not found' : 'Bad request');
    }
  }
  return new AppError(500, ErrorCode.INTERNAL_ERROR, 'Internal server error');
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const appError = normalize(err);
  if (appError.statusCode >= 500) {
    logger.error({ err, requestId: String(req.id), path: req.path, method: req.method }, 'Unhandled error');
  } else {
    logger.debug({ code: appError.code, requestId: String(req.id) }, appError.message);
  }

  const body: ErrorBody = {
    success: false,
    message: appError.message,
    error: { code: appError.code, details: appError.details },
    requestId: String(req.id),
  };
  if (!isProduction && appError.statusCode >= 500 && err instanceof Error) body.error.stack = err.stack;
  if (res.headersSent) return;
  res.status(appError.statusCode).json(body);
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, ErrorCode.NOT_FOUND, `Route ${req.method} ${req.path} not found`));
}
