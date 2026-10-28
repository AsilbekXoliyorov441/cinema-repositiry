import type { Response } from 'express';
import type { PaginationMeta } from '../utils/pagination.js';

export interface SuccessBody<T> {
  success: true;
  message: string;
  data: T;
  meta: PaginationMeta | Record<string, unknown> | null;
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  options: { message?: string; status?: number; meta?: SuccessBody<T>['meta'] } = {},
): void {
  const body: SuccessBody<T> = {
    success: true,
    message: options.message ?? 'Operation completed',
    data,
    meta: options.meta ?? null,
  };
  res.status(options.status ?? 200).json(body);
}

export function sendCreated<T>(res: Response, data: T, message = 'Created'): void {
  sendSuccess(res, data, { status: 201, message });
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}
