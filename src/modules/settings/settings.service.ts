import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { AppError } from '../../common/errors/app-error.js';
import { cache, CacheNamespace } from '../../common/cache/cache.service.js';
import { writeAudit } from '../audit-logs/audit.service.js';

/**
 * Typed, allowlisted runtime settings stored in `site_settings`. Unknown keys are rejected;
 * each key declares its schema, default and the permission needed to change it.
 */
export const SETTING_DEFINITIONS = {
  'reviews.requireWatched': {
    schema: z.boolean(),
    default: false,
    description: 'Only users who started watching a movie may review it',
    permission: 'settings:manage',
  },
  'reviews.autoHideReportThreshold': {
    schema: z.number().int().min(0).max(100),
    default: 5,
    description: 'Hide a review automatically after this many open reports (0 = never)',
    permission: 'settings:manage',
  },
  'catalog.maintenanceBanner': {
    schema: z.string().max(500).nullable(),
    default: null,
    description: 'Optional banner text shown by the frontend',
    permission: 'settings:manage',
  },
  'payments.enabledProviders': {
    schema: z.array(z.enum(['STRIPE'])).max(5),
    default: ['STRIPE'],
    description: 'Payment providers offered at checkout',
    permission: 'payment_settings:manage',
  },
  'subscriptions.expiryReminderDays': {
    schema: z.number().int().min(1).max(30),
    default: 3,
    description: 'Days before period end to send the expiry reminder',
    permission: 'settings:manage',
  },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFINITIONS)[K]['schema']>;

export const settingKeys = Object.keys(SETTING_DEFINITIONS) as [SettingKey, ...SettingKey[]];

async function loadAll(): Promise<Record<string, unknown>> {
  return cache.wrap(CacheNamespace.SETTINGS, 'all', 300, async () => {
    const rows = await prisma.siteSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });
}

export const settingsService = {
  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const def = SETTING_DEFINITIONS[key];
    const stored = (await loadAll())[key];
    const parsed = def.schema.safeParse(stored);
    return (parsed.success ? parsed.data : def.default) as SettingValue<K>;
  },

  async list() {
    const stored = await loadAll();
    return settingKeys.map((key) => {
      const def = SETTING_DEFINITIONS[key];
      const parsed = def.schema.safeParse(stored[key]);
      return { key, value: parsed.success ? parsed.data : def.default, default: def.default, description: def.description, permission: def.permission };
    });
  },

  async set(key: SettingKey, value: unknown, actor: { userId: string; permissions: ReadonlySet<string>; client?: { ip?: string | undefined; userAgent?: string | undefined } }) {
    const def = SETTING_DEFINITIONS[key];
    if (!actor.permissions.has(def.permission)) throw AppError.forbidden();
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) throw AppError.validation(parsed.error.issues.map((i) => ({ path: 'value', message: i.message })));
    const json = parsed.data as Prisma.InputJsonValue;
    await prisma.$transaction(async (tx) => {
      await tx.siteSetting.upsert({ where: { key }, create: { key, value: json, updatedById: actor.userId }, update: { value: json, updatedById: actor.userId } });
      await writeAudit({ actorId: actor.userId, action: 'settings.update', entityType: 'setting', entityId: key, severity: 'HIGH', metadata: { value: json }, client: actor.client }, tx);
    });
    await cache.invalidate(CacheNamespace.SETTINGS);
    return { key, value: parsed.data };
  },
};
