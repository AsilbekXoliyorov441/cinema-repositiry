/**
 * Permission catalogue. Keys are stable identifiers stored in the `permissions` table;
 * the seed keeps the table in sync with this list.
 */
export const PERMISSIONS = {
  USERS_READ: 'users:read',
  USERS_MANAGE: 'users:manage',
  USERS_ASSIGN_ROLES: 'users:assign_roles',
  ROLES_READ: 'roles:read',
  ROLES_MANAGE: 'roles:manage',

  CONTENT_READ: 'content:read',
  CONTENT_WRITE: 'content:write',
  CONTENT_PUBLISH: 'content:publish',
  CONTENT_DELETE: 'content:delete',
  CONTENT_IMPORT: 'content:import',

  MEDIA_READ: 'media:read',
  MEDIA_UPLOAD: 'media:upload',
  MEDIA_DELETE: 'media:delete',

  REVIEWS_MODERATE: 'reviews:moderate',
  REPORTS_READ: 'reports:read',

  PLANS_MANAGE: 'plans:manage',
  COUPONS_MANAGE: 'coupons:manage',
  SUBSCRIPTIONS_READ: 'subscriptions:read',
  SUBSCRIPTIONS_MANAGE: 'subscriptions:manage',
  PAYMENTS_READ: 'payments:read',
  PAYMENTS_REFUND: 'payments:refund',
  PAYMENT_SETTINGS_MANAGE: 'payment_settings:manage',

  ANALYTICS_READ: 'analytics:read',
  AUDIT_READ: 'audit:read',
  AUDIT_READ_SENSITIVE: 'audit:read_sensitive',
  SETTINGS_MANAGE: 'settings:manage',
  JOBS_MANAGE: 'jobs:manage',
  NOTIFICATIONS_SEND: 'notifications:send',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'users:read': 'View user accounts',
  'users:manage': 'Ban, unban and edit user accounts',
  'users:assign_roles': 'Assign roles to users (only roles below own level)',
  'roles:read': 'View roles and permissions',
  'roles:manage': 'Create, edit and delete roles',
  'content:read': 'View all content including drafts',
  'content:write': 'Create and edit movies, series, genres, people, collections, videos',
  'content:publish': 'Publish and archive content',
  'content:delete': 'Delete content',
  'content:import': 'Bulk import and export content',
  'media:read': 'Browse the media library',
  'media:upload': 'Upload images',
  'media:delete': 'Delete media files',
  'reviews:moderate': 'Hide, unhide and delete reviews',
  'reports:read': 'View and resolve review reports',
  'plans:manage': 'Manage subscription plans',
  'coupons:manage': 'Manage coupons',
  'subscriptions:read': 'View subscriptions',
  'subscriptions:manage': 'Grant, extend, suspend and cancel subscriptions manually',
  'payments:read': 'View payments',
  'payments:refund': 'Issue refunds through the payment provider',
  'payment_settings:manage': 'Manage payment provider configuration',
  'analytics:read': 'View dashboard and analytics',
  'audit:read': 'View audit logs',
  'audit:read_sensitive': 'View high-severity audit logs',
  'settings:manage': 'Change site settings',
  'jobs:manage': 'Inspect and retry background jobs',
  'notifications:send': 'Send system notifications to users',
};

export const SYSTEM_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  MODERATOR: 'MODERATOR',
  USER: 'USER',
} as const;

export type SystemRole = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

const P = PERMISSIONS;

export const DEFAULT_ROLE_DEFINITIONS: Record<SystemRole, { level: number; description: string; permissions: Permission[] }> = {
  SUPER_ADMIN: {
    level: 100,
    description: 'Full access including roles, payment configuration and sensitive audit logs',
    permissions: ALL_PERMISSIONS,
  },
  ADMIN: {
    level: 80,
    description: 'Manages content, users, plans, coupons and views analytics',
    permissions: [
      P.USERS_READ,
      P.USERS_MANAGE,
      P.USERS_ASSIGN_ROLES,
      P.ROLES_READ,
      P.CONTENT_READ,
      P.CONTENT_WRITE,
      P.CONTENT_PUBLISH,
      P.CONTENT_DELETE,
      P.CONTENT_IMPORT,
      P.MEDIA_READ,
      P.MEDIA_UPLOAD,
      P.MEDIA_DELETE,
      P.REVIEWS_MODERATE,
      P.REPORTS_READ,
      P.PLANS_MANAGE,
      P.COUPONS_MANAGE,
      P.SUBSCRIPTIONS_READ,
      P.SUBSCRIPTIONS_MANAGE,
      P.PAYMENTS_READ,
      P.PAYMENTS_REFUND,
      P.ANALYTICS_READ,
      P.AUDIT_READ,
      P.NOTIFICATIONS_SEND,
    ],
  },
  MODERATOR: {
    level: 50,
    description: 'Moderates reviews and handles reports',
    permissions: [P.REVIEWS_MODERATE, P.REPORTS_READ, P.CONTENT_READ],
  },
  USER: {
    level: 10,
    description: 'Registered user',
    permissions: [],
  },
};

/** Roles whose holders count as staff (used for MFA enforcement). */
export const STAFF_MIN_LEVEL = 50;
