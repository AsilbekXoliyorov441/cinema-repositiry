import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { z } from 'zod';
import { env } from '../../config/env.js';
import { openApiRegistry, type HttpMethod } from '../../docs/openapi-registry.js';
import { authenticate, requirePermissions, requireVerifiedEmail } from '../middleware/authenticate.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../errors/app-error.js';
import type { Permission } from '../constants/permissions.js';
import type { AuthContext } from '../types/auth.js';

type Infer<T> = T extends z.ZodType ? z.output<T> : undefined;

export interface RouteContext<P, Q, B> {
  req: Request;
  res: Response;
  params: P;
  query: Q;
  body: B;
  /** Principal when authenticated (always set when auth = 'user'). */
  auth: AuthContext | undefined;
  /** Returns the principal or throws 401 — convenient in handlers for authenticated routes. */
  actor(): AuthContext;
  /** Request metadata used by audit logs and sessions. */
  client: { ip: string | undefined; userAgent: string | undefined };
}

export interface RouteConfig<
  P extends z.ZodType | undefined,
  Q extends z.ZodType | undefined,
  B extends z.ZodType | undefined,
> {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  tags?: string[];
  /** public: no auth; optional: auth when token present; user: token required. Permissions imply 'user'. */
  auth?: 'public' | 'optional' | 'user';
  permissions?: Permission[];
  requireVerifiedEmail?: boolean;
  params?: P;
  query?: Q;
  body?: B;
  /** Middleware executed before validation (rate limiters run first, then multer etc.). */
  rateLimit?: RequestHandler;
  before?: RequestHandler[];
  multipartSchema?: Record<string, unknown>;
  response?: z.ZodType | null;
  responseStatus?: number;
  responseDescription?: string;
  paginated?: boolean;
  errors?: number[];
  extraSecurity?: Record<string, string[]>[];
  rawResponse?: { contentType: string; description: string };
  handler: (ctx: RouteContext<Infer<P>, Infer<Q>, Infer<B>>) => Promise<void> | void;
}

/**
 * Declarative router: one definition wires rate limiting, authentication, authorization,
 * Zod validation, the controller handler and the OpenAPI operation — so no endpoint can be
 * exposed without validation or documentation.
 */
export class ApiRouter {
  readonly router = Router();

  constructor(private readonly defaultTag: string) {}

  route<
    P extends z.ZodType | undefined = undefined,
    Q extends z.ZodType | undefined = undefined,
    B extends z.ZodType | undefined = undefined,
  >(config: RouteConfig<P, Q, B>): this {
    const permissions = config.permissions ?? [];
    const auth = permissions.length || config.requireVerifiedEmail ? 'user' : (config.auth ?? 'public');

    const chain: RequestHandler[] = [];
    if (config.rateLimit && auth === 'public') chain.push(config.rateLimit);
    if (auth === 'user') chain.push(authenticate('required'));
    if (auth === 'optional') chain.push(authenticate('optional'));
    // Per-user limiters need req.auth, so they run after authentication.
    if (config.rateLimit && auth !== 'public') chain.push(config.rateLimit);
    if (permissions.length) chain.push(requirePermissions(permissions));
    if (config.requireVerifiedEmail) chain.push(requireVerifiedEmail);
    chain.push(...(config.before ?? []));
    chain.push(validate({ params: config.params, query: config.query, body: config.body }));
    chain.push(async (req, res) => {
      await config.handler({
        req,
        res,
        params: req.valid.params as Infer<P>,
        query: req.valid.query as Infer<Q>,
        body: req.valid.body as Infer<B>,
        auth: req.auth,
        actor: () => {
          if (!req.auth) throw AppError.unauthenticated();
          return req.auth;
        },
        client: { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500) },
      });
    });

    this.router[config.method](config.path, ...chain);

    openApiRegistry.add({
      method: config.method,
      path: `${env.API_PREFIX}${config.path}`,
      tags: config.tags ?? [this.defaultTag],
      summary: config.summary,
      description: config.description,
      auth,
      permissions,
      params: config.params,
      query: config.query,
      body: config.body,
      bodyContentType: config.multipartSchema ? 'multipart/form-data' : 'application/json',
      multipartSchema: config.multipartSchema,
      response: config.response,
      responseStatus: config.responseStatus ?? 200,
      responseDescription: config.responseDescription,
      paginated: config.paginated ?? false,
      errors: config.errors ?? [],
      extraSecurity: config.extraSecurity,
      rawResponse: config.rawResponse,
    });
    return this;
  }
}
