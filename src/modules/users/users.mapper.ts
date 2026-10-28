import { z } from 'zod';
import { imageSelect, toImageView, type MediaLike } from '../media/media.urls.js';
import { imageViewSchema } from '../media/media.schemas.js';

export const userProfileSelect = {
  id: true,
  email: true,
  displayName: true,
  birthDate: true,
  status: true,
  emailVerifiedAt: true,
  mfaEnabled: true,
  createdAt: true,
  avatar: { select: imageSelect },
  roles: {
    select: {
      role: { select: { name: true, level: true, permissions: { select: { permission: { select: { key: true } } } } } },
    },
  },
} as const;

interface UserProfileRow {
  id: string;
  email: string;
  displayName: string;
  birthDate: Date | null;
  status: string;
  emailVerifiedAt: Date | null;
  mfaEnabled: boolean;
  createdAt: Date;
  avatar: MediaLike | null;
  roles: { role: { name: string; level: number; permissions: { permission: { key: string } }[] } }[];
}

export const userProfileSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  birthDate: z.string().nullable(),
  status: z.string(),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  avatar: imageViewSchema.nullable(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()).describe('Informational, for UI only — the API enforces permissions server-side'),
  createdAt: z.string(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export function toUserProfile(user: UserProfileRow): UserProfile {
  const permissions = new Set<string>();
  for (const { role } of user.roles) role.permissions.forEach((p) => permissions.add(p.permission.key));
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    birthDate: user.birthDate ? user.birthDate.toISOString().slice(0, 10) : null,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
    mfaEnabled: user.mfaEnabled,
    avatar: toImageView(user.avatar),
    roles: user.roles.map((r) => r.role.name),
    permissions: [...permissions].sort(),
    createdAt: user.createdAt.toISOString(),
  };
}
