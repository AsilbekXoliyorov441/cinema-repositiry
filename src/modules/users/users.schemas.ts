import { z } from 'zod';
import { paginationQuery, sortQuery } from '../../common/utils/pagination.js';
import { searchTerm } from '../../common/utils/search.js';
import { userProfileSchema } from './users.mapper.js';

export const updateMeBody = z
  .object({
    displayName: z.string().trim().min(2).max(80).optional(),
    birthDate: z.iso
      .date()
      .refine((d) => new Date(d) < new Date() && new Date(d) > new Date('1900-01-01'), 'Invalid birth date')
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const deleteMeBody = z.object({ password: z.string().min(1).max(128) });

export const adminListUsersQuery = paginationQuery.extend({
  q: searchTerm.describe('Search by email or display name'),
  status: z.enum(['ACTIVE', 'BANNED', 'DISABLED', 'DELETED']).optional(),
  role: z.string().max(50).optional(),
  sort: sortQuery(['createdAt', 'email', 'lastLoginAt'], '-createdAt'),
});

export const banBody = z.object({
  reason: z.string().trim().min(3).max(500),
  status: z.enum(['BANNED', 'DISABLED']).default('BANNED'),
});

export const setRolesBody = z.object({ roles: z.array(z.string().max(50)).min(1).max(10) });

export const adminUserSchema = userProfileSchema.extend({
  statusReason: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  isProtected: z.boolean(),
  activeSubscription: z
    .object({ id: z.uuid(), planName: z.string(), status: z.string(), currentPeriodEnd: z.string().nullable() })
    .nullable(),
});
