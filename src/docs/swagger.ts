import { Router, type NextFunction, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from '../config/env.js';
import { basicAuth } from '../common/middleware/basic-auth.js';
import { openApiRegistry } from './openapi-registry.js';

const DESCRIPTION = `
CineWave REST API.

**Response envelope** — every JSON response is either
\`{ success: true, message, data, meta }\` or \`{ success: false, message, error: { code, details }, requestId }\`.

**Authentication** — send \`Authorization: Bearer <accessToken>\`. Access tokens live ${env.JWT_ACCESS_EXPIRES_IN}.
The refresh token is an HttpOnly cookie scoped to \`${env.API_PREFIX}/auth\`; call \`POST /auth/refresh\` with
header \`X-Requested-With: XMLHttpRequest\` and \`credentials: 'include'\` to rotate it.

**Pagination** — list endpoints accept \`page\` (1-based) and \`limit\` (max 100) and return \`meta\` with totals.

**Tags** — tags starting with \`Admin\` require staff permissions listed on each operation.
`.trim();

export function buildOpenApiDocument() {
  return openApiRegistry.build({
    title: 'CineWave API',
    version: '1.0.0',
    description: DESCRIPTION,
    serverUrl: env.APP_URL,
  });
}

export function createDocsRouter(): Router {
  const router = Router();
  if (!env.SWAGGER_ENABLED) return router;
  if (env.SWAGGER_USER && env.SWAGGER_PASSWORD) router.use('/docs', basicAuth(env.SWAGGER_USER, env.SWAGGER_PASSWORD));

  let cached: ReturnType<typeof buildOpenApiDocument> | undefined;
  const doc = () => (cached ??= buildOpenApiDocument());

  router.get('/docs/openapi.json', (_req, res) => {
    res.json(doc());
  });
  router.use('/docs', swaggerUi.serve, (req: Request, res: Response, next: NextFunction) => {
    swaggerUi.setup(doc(), {
      customSiteTitle: 'CineWave API',
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none', tagsSorter: 'alpha', operationsSorter: 'alpha' },
    })(req, res, next);
  });
  return router;
}
