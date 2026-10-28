import { z } from 'zod';

type JsonSchema = Record<string, unknown>;
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface OperationSpec {
  method: HttpMethod;
  path: string; // express style, already prefixed
  tags: string[];
  summary: string;
  description?: string;
  auth: 'public' | 'optional' | 'user';
  permissions: string[];
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  bodyContentType: 'application/json' | 'multipart/form-data';
  multipartSchema?: JsonSchema;
  response?: z.ZodType | null;
  responseStatus: number;
  responseDescription?: string;
  paginated: boolean;
  errors: number[];
  extraSecurity?: Record<string, string[]>[];
  rawResponse?: { contentType: string; description: string };
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad request',
  401: 'Authentication required or token invalid',
  402: 'Payment error',
  403: 'Forbidden — missing permission, unverified email, subscription or age restriction',
  404: 'Resource not found',
  409: 'Conflict — duplicate or invalid state',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Validation error',
  429: 'Too many requests',
  503: 'Dependency unavailable',
};

export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}

function toExpressToOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function parametersFrom(schema: z.ZodType | undefined, location: 'path' | 'query') {
  if (!schema) return [];
  const json = toJsonSchema(schema, 'input');
  const props = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, prop]) => ({
    name,
    in: location,
    required: location === 'path' ? true : required.has(name),
    description: typeof prop.description === 'string' ? prop.description : undefined,
    schema: prop,
  }));
}

const paginationMetaSchema: JsonSchema = {
  type: 'object',
  properties: {
    page: { type: 'integer' },
    limit: { type: 'integer' },
    total: { type: 'integer' },
    totalPages: { type: 'integer' },
    hasNextPage: { type: 'boolean' },
    hasPrevPage: { type: 'boolean' },
  },
  required: ['page', 'limit', 'total', 'totalPages', 'hasNextPage', 'hasPrevPage'],
};

function successEnvelope(data: JsonSchema, paginated: boolean): JsonSchema {
  return {
    type: 'object',
    properties: {
      success: { type: 'boolean', const: true },
      message: { type: 'string', example: 'Operation completed' },
      data: paginated ? { type: 'array', items: data } : data,
      meta: paginated ? paginationMetaSchema : { type: ['object', 'null'] },
    },
    required: ['success', 'message', 'data', 'meta'],
  };
}

export class OpenApiRegistry {
  private readonly operations: OperationSpec[] = [];

  add(op: OperationSpec): void {
    this.operations.push(op);
  }

  list(): readonly OperationSpec[] {
    return this.operations;
  }

  build(info: { title: string; version: string; description: string; serverUrl: string }) {
    const paths: Record<string, Record<string, unknown>> = {};
    const tagSet = new Set<string>();

    for (const op of this.operations) {
      const path = toExpressToOpenApiPath(op.path);
      op.tags.forEach((t) => tagSet.add(t));

      const accessLines = [
        `**Auth:** ${op.auth === 'public' ? 'none (public)' : op.auth === 'optional' ? 'optional — personalised when authenticated' : 'required (Bearer access token)'}`,
      ];
      if (op.permissions.length) accessLines.push(`**Permissions:** ${op.permissions.map((p) => `\`${p}\``).join(', ')}`);

      const responses: Record<string, unknown> = {};
      if (op.rawResponse) {
        responses[String(op.responseStatus)] = {
          description: op.rawResponse.description,
          content: { [op.rawResponse.contentType]: { schema: {} } },
        };
      } else if (op.responseStatus === 204) {
        responses['204'] = { description: op.responseDescription ?? 'No content' };
      } else {
        const data = op.response ? toJsonSchema(op.response, 'output') : { type: ['object', 'null'] };
        responses[String(op.responseStatus)] = {
          description: op.responseDescription ?? 'Success',
          content: { 'application/json': { schema: successEnvelope(data, op.paginated) } },
        };
      }
      const errorCodes = new Set<number>([...op.errors, 429]);
      if (op.params || op.query || op.body) errorCodes.add(422);
      if (op.auth === 'user') errorCodes.add(401);
      if (op.permissions.length) errorCodes.add(403);
      for (const code of [...errorCodes].sort()) {
        responses[String(code)] = { $ref: `#/components/responses/Error${code}` };
      }

      const operation: Record<string, unknown> = {
        tags: op.tags,
        summary: op.summary,
        description: [op.description, accessLines.join('  \n')].filter(Boolean).join('\n\n'),
        operationId: `${op.method}_${path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
        parameters: [...parametersFrom(op.params, 'path'), ...parametersFrom(op.query, 'query')],
        responses,
      };
      if (op.auth === 'user') operation.security = op.extraSecurity ?? [{ bearerAuth: [] }];
      else if (op.auth === 'optional') operation.security = [{ bearerAuth: [] }, {}];
      else operation.security = op.extraSecurity ?? [];

      if (op.body || op.multipartSchema) {
        const schema = op.multipartSchema ?? toJsonSchema(op.body as z.ZodType, 'input');
        operation.requestBody = { required: true, content: { [op.bodyContentType]: { schema } } };
      }

      paths[path] ??= {};
      paths[path][op.method] = operation;
    }

    const errorResponses: Record<string, unknown> = {};
    for (const [code, text] of Object.entries(STATUS_TEXT)) {
      errorResponses[`Error${code}`] = {
        description: text,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      };
    }

    return {
      openapi: '3.1.0',
      info: { title: info.title, version: info.version, description: info.description },
      servers: [{ url: info.serverUrl }],
      tags: [...tagSet].sort().map((name) => ({ name })),
      paths,
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          refreshCookie: { type: 'apiKey', in: 'cookie', name: 'cw_refresh' },
          stripeSignature: { type: 'apiKey', in: 'header', name: 'Stripe-Signature' },
        },
        schemas: {
          ErrorResponse: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: false },
              message: { type: 'string', example: 'Request failed' },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string', example: 'VALIDATION_ERROR' },
                  details: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { path: { type: 'string' }, message: { type: 'string' } },
                    },
                  },
                },
                required: ['code', 'details'],
              },
              requestId: { type: 'string' },
            },
            required: ['success', 'message', 'error'],
          },
        },
        responses: errorResponses,
      },
    };
  }
}

export const openApiRegistry = new OpenApiRegistry();
