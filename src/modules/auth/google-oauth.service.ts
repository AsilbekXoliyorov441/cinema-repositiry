import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import { SYSTEM_ROLES } from '../../common/constants/permissions.js';
import { randomToken } from '../../common/utils/crypto.js';
import { writeAudit } from '../audit-logs/audit.service.js';
import { createSession, type IssuedTokens } from './session.service.js';
import { signMfaChallengeToken } from './token.service.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export const googleOAuthEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);

function assertEnabled(): void {
  if (!googleOAuthEnabled) throw AppError.notFound('Google sign-in');
}

/** Builds the Google consent URL with state + PKCE. State and verifier are kept in a short-lived cookie. */
export function buildGoogleAuthorization(): { url: string; state: string; verifier: string } {
  assertEnabled();
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID as string,
    redirect_uri: env.GOOGLE_REDIRECT_URI as string,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state, verifier };
}

interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

async function exchangeCode(code: string, verifier: string): Promise<GoogleIdentity> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID as string,
      client_secret: env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: env.GOOGLE_REDIRECT_URI as string,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw AppError.unauthenticated('Google authorization failed');
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw AppError.unauthenticated('Google did not return an ID token');

  const { payload } = await jwtVerify(body.id_token, googleJwks, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: env.GOOGLE_CLIENT_ID as string,
  });
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || payload.email_verified !== true) {
    throw AppError.unauthenticated('Google account email is not verified');
  }
  return { sub: payload.sub, email: payload.email.toLowerCase(), name: typeof payload.name === 'string' ? payload.name : payload.email };
}

/**
 * Signs a user in with Google. Existing accounts are linked only when Google asserts the email is verified.
 */
export async function completeGoogleLogin(
  code: string,
  verifier: string,
  client: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<{ kind: 'session'; tokens: IssuedTokens } | { kind: 'mfa'; mfaToken: string }> {
  assertEnabled();
  const identity = await exchangeCode(code, verifier);

  const linked = await prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider: 'google', providerAccountId: identity.sub } },
    include: { user: true },
  });

  let userId: string;
  if (linked) {
    userId = linked.userId;
    if (linked.user.status !== 'ACTIVE' || linked.user.deletedAt) throw AppError.forbidden('Account is disabled');
  } else {
    const existing = await prisma.user.findUnique({ where: { email: identity.email } });
    if (existing) {
      if (existing.status !== 'ACTIVE' || existing.deletedAt) throw AppError.forbidden('Account is disabled');
      await prisma.oAuthAccount.create({ data: { userId: existing.id, provider: 'google', providerAccountId: identity.sub } });
      if (!existing.emailVerifiedAt) await prisma.user.update({ where: { id: existing.id }, data: { emailVerifiedAt: new Date() } });
      userId = existing.id;
    } else {
      const role = await prisma.role.findUniqueOrThrow({ where: { name: SYSTEM_ROLES.USER } });
      const user = await prisma.user.create({
        data: {
          email: identity.email,
          displayName: identity.name.slice(0, 80),
          emailVerifiedAt: new Date(),
          roles: { create: { roleId: role.id } },
          oauthAccounts: { create: { provider: 'google', providerAccountId: identity.sub } },
        },
      });
      userId = user.id;
    }
  }
  // Google proves the first factor only; MFA-enabled accounts still need their TOTP code.
  const { mfaEnabled } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaEnabled: true } });
  if (mfaEnabled) return { kind: 'mfa', mfaToken: await signMfaChallengeToken(userId) };

  await writeAudit({ actorId: userId, action: 'auth.login_google', entityType: 'user', entityId: userId, client });
  return { kind: 'session', tokens: await createSession(userId, client, false) };
}
