import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const durationRegex = /^\d+[smhd]$/;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_PREFIX: z.string().startsWith('/').default('/api/v1'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    APP_URL: z.url().default('http://localhost:4000'),
    FRONTEND_URL: z.url().default('http://localhost:3000'),
    ADMIN_URL: z.url().default('http://localhost:3001'),
    CORS_ORIGINS: csv,

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_EXPIRES_IN: z.string().regex(durationRegex).default('15m'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_REFRESH_EXPIRES_IN: z.string().regex(durationRegex).default('30d'),
    JWT_ISSUER: z.string().default('cinewave-api'),
    JWT_AUDIENCE: z.string().default('cinewave-clients'),

    COOKIE_DOMAIN: optionalString,
    COOKIE_SECURE: bool(true),
    COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'),

    MFA_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'MFA_ENCRYPTION_KEY must be 32 bytes hex (64 chars)'),
    REQUIRE_ADMIN_MFA: bool(false),

    STORAGE_DRIVER: z.enum(['local']).default('local'),
    LOCAL_STORAGE_PATH: z.string().default('./storage/uploads'),
    PUBLIC_MEDIA_BASE_URL: optionalString,
    MAX_IMAGE_SIZE_MB: z.coerce.number().positive().max(50).default(10),
    MAX_BULK_UPLOAD_FILES: z.coerce.number().int().min(1).max(50).default(10),
    ORPHAN_MEDIA_GRACE_HOURS: z.coerce.number().int().min(1).default(72),
    ORPHAN_MEDIA_AUTO_DELETE: bool(false),

    EMAIL_PROVIDER: z.enum(['smtp', 'file']).default('file'),
    EMAIL_FROM: z.string().default('CineWave <no-reply@cinewave.local>'),
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: bool(false),
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    EMAIL_FILE_DIR: z.string().default('./storage/dev-mail'),

    PAYMENT_PROVIDER: z.enum(['stripe', 'none']).default('none'),
    PAYMENT_MODE: z.enum(['test', 'live']).default('test'),
    STRIPE_SECRET_KEY: optionalString,
    STRIPE_WEBHOOK_SECRET: optionalString,
    CLICK_MERCHANT_ID: optionalString,
    CLICK_SERVICE_ID: optionalString,
    CLICK_SECRET_KEY: optionalString,
    PAYME_MERCHANT_ID: optionalString,
    PAYME_SECRET_KEY: optionalString,
    CHECKOUT_SUCCESS_PATH: z.string().default('/subscription/success'),
    CHECKOUT_CANCEL_PATH: z.string().default('/subscription/cancel'),
    CHECKOUT_RESERVATION_MINUTES: z.coerce.number().int().min(30).max(1440).default(60),

    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_REDIRECT_URI: optionalString,

    PLAYBACK_SIGNING_SECRET: optionalString,
    PLAYBACK_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
    VIDEO_ALLOWED_HOSTS: csv,
    EMBED_ALLOWED_HOSTS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? 'www.youtube.com,youtube.com,www.youtube-nocookie.com,player.vimeo.com')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),

    SWAGGER_ENABLED: bool(true),
    SWAGGER_USER: optionalString,
    SWAGGER_PASSWORD: optionalString,

    RATE_LIMIT_ENABLED: bool(true),
    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_AUTH_PER_15MIN: z.coerce.number().int().min(1).default(20),

    RUN_WORKERS_IN_API: bool(false),

    BOOTSTRAP_ADMIN_EMAIL: optionalString,
    BOOTSTRAP_ADMIN_PASSWORD: optionalString,

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });

    if (env.PAYMENT_PROVIDER === 'stripe') {
      if (!env.STRIPE_SECRET_KEY) issue('STRIPE_SECRET_KEY', 'Required when PAYMENT_PROVIDER=stripe');
      if (!env.STRIPE_WEBHOOK_SECRET) issue('STRIPE_WEBHOOK_SECRET', 'Required when PAYMENT_PROVIDER=stripe');
      if (env.STRIPE_SECRET_KEY) {
        const isLiveKey = env.STRIPE_SECRET_KEY.startsWith('sk_live_');
        if (env.PAYMENT_MODE === 'test' && isLiveKey) {
          issue('STRIPE_SECRET_KEY', 'Live Stripe key used while PAYMENT_MODE=test');
        }
        if (env.PAYMENT_MODE === 'live' && !isLiveKey) {
          issue('STRIPE_SECRET_KEY', 'PAYMENT_MODE=live requires an sk_live_ key');
        }
      }
    }
    if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) issue('SMTP_HOST', 'Required when EMAIL_PROVIDER=smtp');

    const googleKeys = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI];
    if (googleKeys.some(Boolean) && !googleKeys.every(Boolean)) {
      issue('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI must be set together');
    }

    if (env.NODE_ENV === 'production') {
      if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
        issue('JWT_REFRESH_SECRET', 'Must differ from JWT_ACCESS_SECRET');
      }
      if (/change[-_]?me|example|secret123/i.test(env.JWT_ACCESS_SECRET + env.JWT_REFRESH_SECRET)) {
        issue('JWT_ACCESS_SECRET', 'Placeholder secrets are not allowed in production');
      }
      if (!env.COOKIE_SECURE) issue('COOKIE_SECURE', 'Must be true in production');
      if (env.COOKIE_SAME_SITE === 'none' && !env.COOKIE_SECURE) {
        issue('COOKIE_SAME_SITE', 'SameSite=None requires Secure cookies');
      }
      if (env.EMAIL_PROVIDER !== 'smtp') issue('EMAIL_PROVIDER', 'Production requires EMAIL_PROVIDER=smtp');
      if (env.SWAGGER_ENABLED && !(env.SWAGGER_USER && env.SWAGGER_PASSWORD)) {
        issue('SWAGGER_ENABLED', 'Swagger in production requires SWAGGER_USER and SWAGGER_PASSWORD');
      }
      if (env.BOOTSTRAP_ADMIN_PASSWORD) {
        issue('BOOTSTRAP_ADMIN_PASSWORD', 'Do not keep the bootstrap password in the production environment');
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    // Logger depends on env, so a plain stderr write is used here.
    console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** All origins allowed to call the API with credentials. */
export const allowedOrigins = Array.from(
  new Set([env.FRONTEND_URL, env.ADMIN_URL, ...env.CORS_ORIGINS].map((o) => new URL(o).origin)),
);
