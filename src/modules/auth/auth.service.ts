import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { redis } from '../../config/redis.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { SYSTEM_ROLES, STAFF_MIN_LEVEL } from '../../common/constants/permissions.js';
import { decrypt, encrypt } from '../../common/utils/crypto.js';
import { addMs } from '../../common/utils/duration.js';
import { enqueueEmail } from '../../jobs/queues.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { toUserProfile, userProfileSelect, type UserProfile } from '../users/users.mapper.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password.service.js';
import { createSession, revokeAllUserSessions, rotateRefreshToken, type IssuedTokens } from './session.service.js';
import { generateOpaqueToken, hashOpaqueToken, signMfaChallengeToken, verifyMfaChallengeToken } from './token.service.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp.js';
import type {
  ChangePasswordInput,
  EmailChangeInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from './auth.schemas.js';

const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

interface ClientInfo {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type LoginResult =
  | { mfaRequired: false; tokens: IssuedTokens; user: UserProfile }
  | { mfaRequired: true; mfaToken: string };

async function getProfile(userId: string): Promise<UserProfile> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: userProfileSelect });
  return toUserProfile(user);
}

async function issueEmailVerification(userId: string, email: string, name: string): Promise<void> {
  const { token, hash } = generateOpaqueToken();
  await prisma.$transaction([
    // Invalidate older outstanding tokens so only the latest link works.
    prisma.verificationToken.updateMany({
      where: { userId, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.verificationToken.create({
      data: { userId, purpose: 'EMAIL_VERIFICATION', tokenHash: hash, expiresAt: addMs(new Date(), EMAIL_TOKEN_TTL_MS) },
    }),
  ]);
  await enqueueEmail({ to: email, template: 'verify-email', data: { name, token } });
}

export const authService = {
  async register(input: RegisterInput, client: ClientInfo): Promise<{ tokens: IssuedTokens; user: UserProfile }> {
    const email = input.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      // Registration necessarily reveals that an email is taken; rate limiting bounds enumeration.
      throw AppError.conflict('An account with this email already exists');
    }
    const userRole = await prisma.role.findUnique({ where: { name: SYSTEM_ROLES.USER } });
    if (!userRole) throw AppError.unavailable('Roles are not seeded. Run `npm run db:seed`.');

    const passwordHash = await hashPassword(input.password);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        displayName: input.displayName,
        birthDate: input.birthDate ? new Date(input.birthDate) : null,
        roles: { create: { roleId: userRole.id } },
      },
    });

    await issueEmailVerification(user.id, user.email, user.displayName);
    await enqueueEmail({ to: user.email, template: 'welcome', data: { name: user.displayName } });
    await writeAudit({ actorId: user.id, action: 'auth.register', entityType: 'user', entityId: user.id, client });

    const tokens = await createSession(user.id, client, false);
    return { tokens, user: await getProfile(user.id) };
  },

  async login(input: LoginInput, client: ClientInfo): Promise<LoginResult> {
    const email = input.email.toLowerCase();
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, status: true, deletedAt: true, mfaEnabled: true },
    });

    // Identical error for "no such user" and "wrong password"; dummy hash equalizes timing.
    const invalid = AppError.unauthenticated('Invalid email or password', ErrorCode.INVALID_CREDENTIALS);
    if (!user || !user.passwordHash || user.deletedAt) {
      await burnPasswordCheck(input.password);
      throw invalid;
    }
    if (!(await verifyPassword(user.passwordHash, input.password))) {
      await writeAudit({ actorId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, client });
      throw invalid;
    }
    if (user.status !== 'ACTIVE') {
      throw AppError.forbidden('Account is disabled', ErrorCode.ACCOUNT_DISABLED);
    }
    if (user.mfaEnabled) {
      return { mfaRequired: true, mfaToken: await signMfaChallengeToken(user.id) };
    }

    const tokens = await createSession(user.id, client, false);
    await writeAudit({ actorId: user.id, action: 'auth.login', entityType: 'session', entityId: tokens.sessionId, client });
    return { mfaRequired: false, tokens, user: await getProfile(user.id) };
  },

  async completeMfaLogin(mfaToken: string, code: string, client: ClientInfo) {
    const userId = await verifyMfaChallengeToken(mfaToken);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, mfaEnabled: true, mfaSecretEnc: true },
    });
    if (!user || user.status !== 'ACTIVE' || !user.mfaEnabled || !user.mfaSecretEnc) {
      throw AppError.unauthenticated('MFA challenge invalid');
    }
    await assertTotp(user.id, user.mfaSecretEnc, code);
    const tokens = await createSession(user.id, client, true);
    await writeAudit({ actorId: user.id, action: 'auth.login_mfa', entityType: 'session', entityId: tokens.sessionId, client });
    return { tokens, user: await getProfile(user.id) };
  },

  refresh(rawToken: string, client: ClientInfo): Promise<IssuedTokens> {
    return rotateRefreshToken(rawToken, client);
  },

  async verifyEmail(token: string): Promise<void> {
    const record = await prisma.verificationToken.findUnique({ where: { tokenHash: hashOpaqueToken(token) } });
    if (!record || record.purpose !== 'EMAIL_VERIFICATION' || record.usedAt || record.expiresAt < new Date()) {
      throw AppError.badRequest('Verification link is invalid or has expired');
    }
    await prisma.$transaction(async (tx) => {
      const used = await tx.verificationToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count !== 1) throw AppError.badRequest('Verification link is invalid or has expired');
      await tx.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    });
  },

  async resendVerification(userId: string): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) throw AppError.conflict('Email is already verified');
    await issueEmailVerification(user.id, user.email, user.displayName);
  },

  /** Always resolves without revealing whether the email exists. */
  async forgotPassword(emailInput: string, client: ClientInfo): Promise<void> {
    const email = emailInput.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.deletedAt || user.status !== 'ACTIVE' || !user.passwordHash) return;

    const { token, hash } = generateOpaqueToken();
    await prisma.$transaction([
      prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
      prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hash, expiresAt: addMs(new Date(), RESET_TOKEN_TTL_MS), ipAddress: client.ip ?? null },
      }),
    ]);
    await enqueueEmail({ to: user.email, template: 'password-reset', data: { name: user.displayName, token } });
    await writeAudit({ actorId: user.id, action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id, client });
  },

  async resetPassword(input: ResetPasswordInput, client: ClientInfo): Promise<void> {
    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashOpaqueToken(input.token) },
      include: { user: { select: { id: true, email: true, displayName: true, status: true } } },
    });
    if (!record || record.usedAt || record.expiresAt < new Date() || record.user.status !== 'ACTIVE') {
      throw AppError.badRequest('Reset link is invalid or has expired');
    }
    const passwordHash = await hashPassword(input.password);
    await prisma.$transaction(async (tx) => {
      const used = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count !== 1) throw AppError.badRequest('Reset link is invalid or has expired');
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await tx.session.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: 'password_reset' },
      });
    });
    await enqueueEmail({ to: record.user.email, template: 'password-changed', data: { name: record.user.displayName } });
    await writeAudit({ actorId: record.userId, action: 'auth.password_reset', entityType: 'user', entityId: record.userId, severity: 'MEDIUM', client });
  },

  async changePassword(userId: string, sessionId: string, input: ChangePasswordInput, client: ClientInfo): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw AppError.badRequest('Current password is incorrect');
    }
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(input.newPassword) } });
    await revokeAllUserSessions(userId, 'password_changed', sessionId);
    await enqueueEmail({ to: user.email, template: 'password-changed', data: { name: user.displayName } });
    await writeAudit({ actorId: userId, action: 'auth.password_changed', entityType: 'user', entityId: userId, severity: 'MEDIUM', client });
  },

  async requestEmailChange(userId: string, input: EmailChangeInput): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.password))) {
      throw AppError.badRequest('Password is incorrect');
    }
    const newEmail = input.newEmail.toLowerCase();
    if (newEmail === user.email) throw AppError.badRequest('New email must be different');
    const taken = await prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } });
    if (taken) throw AppError.conflict('This email is already in use');

    const { token, hash } = generateOpaqueToken();
    await prisma.$transaction([
      prisma.verificationToken.updateMany({ where: { userId, purpose: 'EMAIL_CHANGE', usedAt: null }, data: { usedAt: new Date() } }),
      prisma.verificationToken.create({
        data: { userId, purpose: 'EMAIL_CHANGE', tokenHash: hash, newEmail, expiresAt: addMs(new Date(), EMAIL_TOKEN_TTL_MS) },
      }),
    ]);
    await enqueueEmail({ to: newEmail, template: 'email-change', data: { name: user.displayName, token, newEmail } });
  },

  async confirmEmailChange(token: string, client: ClientInfo): Promise<void> {
    const record = await prisma.verificationToken.findUnique({ where: { tokenHash: hashOpaqueToken(token) } });
    if (!record || record.purpose !== 'EMAIL_CHANGE' || !record.newEmail || record.usedAt || record.expiresAt < new Date()) {
      throw AppError.badRequest('Confirmation link is invalid or has expired');
    }
    const newEmail = record.newEmail;
    const old = await prisma.$transaction(async (tx) => {
      const used = await tx.verificationToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
      if (used.count !== 1) throw AppError.badRequest('Confirmation link is invalid or has expired');
      const before = await tx.user.findUniqueOrThrow({ where: { id: record.userId }, select: { email: true } });
      // Unique constraint on users.email guards against a race with a concurrent registration.
      await tx.user.update({ where: { id: record.userId }, data: { email: newEmail, emailVerifiedAt: new Date() } });
      return before.email;
    });
    await revokeAllUserSessions(record.userId, 'email_changed');
    await writeAudit({
      actorId: record.userId,
      action: 'auth.email_changed',
      entityType: 'user',
      entityId: record.userId,
      severity: 'MEDIUM',
      metadata: { from: old, to: newEmail },
      client,
    });
  },

  // ───── MFA (TOTP) ─────

  async setupMfa(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) throw AppError.conflict('MFA is already enabled');
    const secret = generateTotpSecret();
    await prisma.user.update({ where: { id: userId }, data: { mfaSecretEnc: encrypt(secret, env.MFA_ENCRYPTION_KEY) } });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  },

  async enableMfa(userId: string, sessionId: string, code: string, client: ClientInfo): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) throw AppError.conflict('MFA is already enabled');
    if (!user.mfaSecretEnc) throw AppError.badRequest('Call MFA setup first');
    await assertTotp(userId, user.mfaSecretEnc, code);
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } }),
      prisma.session.update({ where: { id: sessionId }, data: { mfaVerified: true } }),
    ]);
    await writeAudit({ actorId: userId, action: 'auth.mfa_enabled', entityType: 'user', entityId: userId, severity: 'MEDIUM', client });
  },

  async disableMfa(userId: string, password: string, code: string, roleLevel: number, client: ClientInfo): Promise<void> {
    if (env.REQUIRE_ADMIN_MFA && roleLevel >= STAFF_MIN_LEVEL) {
      throw AppError.forbidden('Staff accounts must keep MFA enabled');
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw AppError.badRequest('MFA is not enabled');
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw AppError.badRequest('Password is incorrect');
    }
    await assertTotp(userId, user.mfaSecretEnc, code);
    await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecretEnc: null } });
    await writeAudit({ actorId: userId, action: 'auth.mfa_disabled', entityType: 'user', entityId: userId, severity: 'HIGH', client });
  },

  getProfile,
};

/** Verifies a TOTP code and blocks replay of the same code within its validity window. */
async function assertTotp(userId: string, secretEnc: string, code: string): Promise<void> {
  const step = verifyTotp(decrypt(secretEnc, env.MFA_ENCRYPTION_KEY), code);
  if (step === null) throw AppError.unauthenticated('Invalid MFA code');
  try {
    const fresh = await redis.set(`mfa:used:${userId}:${step}`, '1', 'EX', 120, 'NX');
    if (fresh === null) throw AppError.unauthenticated('MFA code already used');
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Redis down: accept the code (still time-bound) rather than locking staff out.
  }
}
