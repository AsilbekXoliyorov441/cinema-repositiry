import type { AuthContext } from './auth.js';

declare global {
  namespace Express {
    interface Request {
      /** Authenticated principal, set by authenticate middleware. */
      auth?: AuthContext;
      /** Zod-validated request parts. Express 5 makes req.query read-only, so parsed values live here. */
      valid: { params: unknown; query: unknown; body: unknown };
      /** Raw body buffer, populated only for webhook routes. */
      rawBody?: Buffer;
    }
  }
}

export {};
