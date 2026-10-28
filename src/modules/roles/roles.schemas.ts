import { z } from 'zod';
import { ALL_PERMISSIONS } from '../../common/constants/permissions.js';

const permissionKey = z.enum(ALL_PERMISSIONS as [string, ...string[]]);

export const createRoleBody = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{2,49}$/, 'UPPER_SNAKE_CASE, 3-50 characters'),
  description: z.string().trim().max(255).optional(),
  level: z.number().int().min(1).max(99),
  permissions: z.array(permissionKey).max(100).default([]),
});

export const updateRoleBody = z.object({
  description: z.string().trim().max(255).nullable().optional(),
  level: z.number().int().min(1).max(99).optional(),
});

export const setPermissionsBody = z.object({ permissions: z.array(permissionKey).max(100) });

export const roleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  level: z.number().int(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
  userCount: z.number().int(),
});

export const permissionSchema = z.object({ key: z.string(), description: z.string().nullable() });
