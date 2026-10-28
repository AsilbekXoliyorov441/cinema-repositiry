import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { allowedOrigins, env } from './config/env.js';
import { logger } from './config/logger.js';
import { requestId } from './common/middleware/request-id.js';
import { rateLimiters } from './common/middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './common/middleware/error-handler.js';
import { healthRouter } from './modules/health/health.routes.js';
import { createDocsRouter } from './docs/swagger.js';
import { createApiRouter } from './routes.js';
import { createWebhookRouter } from './modules/payments/webhook.routes.js';
import { createMediaStaticRouter } from './modules/media/media.static.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
      },
    }),
  );
  app.use(
    helmet({
      // The API serves JSON only; Swagger UI needs inline scripts/styles on /docs.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // media files are embedded by the frontend
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        // Non-browser clients (no Origin) are allowed; browsers must be on the allowlist.
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
      maxAge: 600,
    }),
  );

  app.use(healthRouter);
  app.use(createMediaStaticRouter());

  // Webhooks need the raw body for signature verification, so they are mounted before express.json().
  app.use(env.API_PREFIX, createWebhookRouter());

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());

  app.use(createDocsRouter());
  app.use(env.API_PREFIX, rateLimiters.global, createApiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
