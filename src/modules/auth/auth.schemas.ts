import { z } from 'zod';
import { passwordSchema } from './password.service.js';
import { userProfileSchema } from '../users/users.mapper.js';

const email = z.email().max(320).transform((v) => v.trim().toLowerCase());

export const registerBody = z.object({
  email,
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(80),
  birthDate: z.iso
    .date()
    .refine((d) => new Date(d) < new Date() && new Date(d) > new Date('1900-01-01'), 'Invalid birth date')
    .optional(),
});
export type RegisterInput = z.infer<typeof registerBody>;

export const loginBody = z.object({
  email,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginBody>;

export const mfaLoginBody = z.object({
  mfaToken: z.string().min(10).max(2000),
  code: z.string().regex(/^\d{6}$/),
});

export const refreshBody = z
  .object({ refreshToken: z.string().min(20).max(200).optional().describe('Only for non-browser clients; browsers use the cookie') })
  .optional()
  .transform((v) => v ?? {});

export const tokenBody = z.object({ token: z.string().min(20).max(200) });
export const emailBody = z.object({ email });

export const resetPasswordBody = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export type ResetPasswordInput = z.infer<typeof resetPasswordBody>;

export const changePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .refine((v) => v.currentPassword !== v.newPassword, { message: 'New password must differ', path: ['newPassword'] });
export type ChangePasswordInput = z.infer<typeof changePasswordBody>;

export const emailChangeBody = z.object({ newEmail: email, password: z.string().min(1).max(128) });
export type EmailChangeInput = z.infer<typeof emailChangeBody>;

export const mfaCodeBody = z.object({ code: z.string().regex(/^\d{6}$/) });
export const mfaDisableBody = z.object({ password: z.string().min(1).max(128), code: z.string().regex(/^\d{6}$/) });

export const sessionIdParam = z.object({ id: z.uuid() });

export const googleCallbackQuery = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(200).optional(),
  error: z.string().max(200).optional(),
});

// ───── Response schemas ─────

export const authTokensResponse = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().describe('Access token lifetime in seconds'),
  user: userProfileSchema,
});

export const loginResponse = z.union([
  authTokensResponse.extend({ mfaRequired: z.literal(false) }),
  z.object({ mfaRequired: z.literal(true), mfaToken: z.string().describe('Send with the TOTP code to /auth/mfa/verify') }),
]);

export const refreshResponse = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int(),
});

export const sessionSchema = z.object({
  id: z.uuid(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
  mfaVerified: z.boolean(),
  current: z.boolean(),
});

export const mfaSetupResponse = z.object({ secret: z.string(), otpauthUrl: z.string() });
