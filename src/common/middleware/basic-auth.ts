import type { NextFunction, Request, Response } from 'express';
import { safeEqual } from '../utils/crypto.js';

/** HTTP Basic auth guard (used to protect Swagger UI in production). */
export function basicAuth(user: string, password: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, ...rest] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      if (u !== undefined && safeEqual(u, user) && safeEqual(rest.join(':'), password)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="CineWave API docs"');
    res.status(401).send('Authentication required');
  };
}
