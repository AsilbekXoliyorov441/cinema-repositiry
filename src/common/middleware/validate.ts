import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { AppError, type ErrorDetail } from '../errors/app-error.js';

export function zodIssuesToDetails(issues: z.core.$ZodIssue[], prefix?: string): ErrorDetail[] {
  return issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].filter(Boolean).join('.'),
    message: i.message,
  }));
}

/** Validates params/query/body with Zod and stores the parsed output on `req.valid`. */
export function validate(schemas: { params?: z.ZodType; query?: z.ZodType; body?: z.ZodType }) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const details: ErrorDetail[] = [];
    const valid: Request['valid'] = { params: req.params, query: {}, body: undefined };

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const input: unknown = part === 'body' ? (req.body ?? {}) : req[part];
      const result = await schema.safeParseAsync(input);
      if (result.success) valid[part] = result.data;
      else details.push(...zodIssuesToDetails(result.error.issues, part));
    }
    if (details.length) throw AppError.validation(details);
    req.valid = valid;
    next();
  };
}
