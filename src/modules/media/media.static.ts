import express, { Router } from 'express';
import { localStorage } from '../../integrations/storage/index.js';

/**
 * Serves PUBLIC media files from local disk under /media. Hardening:
 *  - only the `public/` subtree is exposed; private files go through the authenticated API
 *  - no directory listing, no dotfiles, no index files
 *  - nosniff + restrictive CSP so a file can never execute as HTML/JS
 *  - keys are random UUIDs, so responses are cached as immutable
 */
export function createMediaStaticRouter(): Router {
  const router = Router();
  router.use(
    '/media',
    express.static(localStorage.publicDir, {
      dotfiles: 'deny',
      index: false,
      redirect: false,
      fallthrough: false,
      immutable: true,
      maxAge: '365d',
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
        res.setHeader('Content-Disposition', 'inline');
      },
    }),
  );
  return router;
}
