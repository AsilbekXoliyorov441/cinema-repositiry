import type { Response } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/app-error.js';
import { sendCreated, sendSuccess } from '../../common/http/response.js';
import type { RouteContext } from '../../common/http/api-router.js';
import type { z } from 'zod';
import { authService } from './auth.service.js';
import { clearRefreshCookie, readRefreshToken, setRefreshCookie } from './auth.cookies.js';
import type { IssuedTokens } from './session.service.js';
import {
  listActiveSessions,
  revokeAllUserSessions,
  revokeOwnSession,
  revokeSessionByRefreshToken,
} from './session.service.js';
import { buildGoogleAuthorization, completeGoogleLogin } from './google-oauth.service.js';
import type * as S from './auth.schemas.js';

type Ctx<P = undefined, Q = undefined, B = undefined> = RouteContext<P, Q, B>;

const OAUTH_COOKIE = 'cw_oauth';

function respondWithTokens(res: Response, tokens: IssuedTokens) {
  setRefreshCookie(res, tokens.refreshToken, tokens.refreshTokenExpiresAt);
  return { accessToken: tokens.accessToken, tokenType: 'Bearer' as const, expiresIn: tokens.accessTokenExpiresIn };
}

export const authController = {
  async register({ res, body, client }: Ctx<undefined, undefined, z.infer<typeof S.registerBody>>) {
    const { tokens, user } = await authService.register(body, client);
    sendCreated(res, { ...respondWithTokens(res, tokens), user }, 'Account created. Please verify your email.');
  },

  async login({ res, body, client }: Ctx<undefined, undefined, z.infer<typeof S.loginBody>>) {
    const result = await authService.login(body, client);
    if (result.mfaRequired) {
      sendSuccess(res, { mfaRequired: true, mfaToken: result.mfaToken }, { message: 'MFA code required' });
      return;
    }
    sendSuccess(res, { mfaRequired: false, ...respondWithTokens(res, result.tokens), user: result.user }, { message: 'Logged in' });
  },

  async verifyMfaLogin({ res, body, client }: Ctx<undefined, undefined, z.infer<typeof S.mfaLoginBody>>) {
    const { tokens, user } = await authService.completeMfaLogin(body.mfaToken, body.code, client);
    sendSuccess(res, { ...respondWithTokens(res, tokens), user }, { message: 'Logged in' });
  },

  async refresh({ req, res, body, client }: Ctx<undefined, undefined, z.infer<typeof S.refreshBody>>) {
    const raw = readRefreshToken(req, body.refreshToken);
    if (!raw) throw AppError.unauthenticated('Refresh token missing');
    try {
      const tokens = await authService.refresh(raw, client);
      sendSuccess(res, respondWithTokens(res, tokens), { message: 'Token refreshed' });
    } catch (err) {
      clearRefreshCookie(res);
      throw err;
    }
  },

  async logout({ req, res, body }: Ctx<undefined, undefined, z.infer<typeof S.refreshBody>>) {
    const raw = readRefreshToken(req, body.refreshToken);
    if (raw) await revokeSessionByRefreshToken(raw);
    clearRefreshCookie(res);
    sendSuccess(res, null, { message: 'Logged out' });
  },

  async logoutAll({ res, actor }: Ctx) {
    const count = await revokeAllUserSessions(actor().userId, 'logout_all');
    clearRefreshCookie(res);
    sendSuccess(res, { revokedSessions: count }, { message: 'Logged out from all sessions' });
  },

  async me({ res, actor }: Ctx) {
    sendSuccess(res, await authService.getProfile(actor().userId));
  },

  async verifyEmail({ res, body }: Ctx<undefined, undefined, z.infer<typeof S.tokenBody>>) {
    await authService.verifyEmail(body.token);
    sendSuccess(res, null, { message: 'Email verified' });
  },

  async resendVerification({ res, actor }: Ctx) {
    await authService.resendVerification(actor().userId);
    sendSuccess(res, null, { message: 'Verification email sent' });
  },

  async forgotPassword({ res, body, client }: Ctx<undefined, undefined, z.infer<typeof S.emailBody>>) {
    await authService.forgotPassword(body.email, client);
    sendSuccess(res, null, { message: 'If an account exists for this email, a reset link has been sent' });
  },

  async resetPassword({ res, body, client }: Ctx<undefined, undefined, z.infer<typeof S.resetPasswordBody>>) {
    await authService.resetPassword(body, client);
    clearRefreshCookie(res);
    sendSuccess(res, null, { message: 'Password updated. Please log in again.' });
  },

  async changePassword({ res, body, actor, client }: Ctx<undefined, undefined, z.infer<typeof S.changePasswordBody>>) {
    const a = actor();
    await authService.changePassword(a.userId, a.sessionId, body, client);
    sendSuccess(res, null, { message: 'Password changed. Other sessions were signed out.' });
  },

  async requestEmailChange({ res, body, actor }: Ctx<undefined, undefined, z.infer<typeof S.emailChangeBody>>) {
    await authService.requestEmailChange(actor().userId, body);
    sendSuccess(res, null, { message: 'Confirmation link sent to the new email address' });
  },

  async confirmEmailChange({ res, body, client }: Ctx<undefined, undefined, z.infer<typeof S.tokenBody>>) {
    await authService.confirmEmailChange(body.token, client);
    clearRefreshCookie(res);
    sendSuccess(res, null, { message: 'Email changed. Please log in again.' });
  },

  async sessions({ res, actor }: Ctx) {
    const a = actor();
    sendSuccess(res, await listActiveSessions(a.userId, a.sessionId));
  },

  async revokeSession({ res, params, actor }: Ctx<z.infer<typeof S.sessionIdParam>>) {
    await revokeOwnSession(actor().userId, params.id);
    sendSuccess(res, null, { message: 'Session revoked' });
  },

  async revokeOtherSessions({ res, actor }: Ctx) {
    const a = actor();
    const count = await revokeAllUserSessions(a.userId, 'user_revoked_others', a.sessionId);
    sendSuccess(res, { revokedSessions: count }, { message: 'Other sessions revoked' });
  },

  async mfaSetup({ res, actor }: Ctx) {
    sendSuccess(res, await authService.setupMfa(actor().userId), { message: 'Scan the QR code, then confirm with a code' });
  },

  async mfaEnable({ res, body, actor, client }: Ctx<undefined, undefined, z.infer<typeof S.mfaCodeBody>>) {
    const a = actor();
    await authService.enableMfa(a.userId, a.sessionId, body.code, client);
    sendSuccess(res, null, { message: 'MFA enabled' });
  },

  async mfaDisable({ res, body, actor, client }: Ctx<undefined, undefined, z.infer<typeof S.mfaDisableBody>>) {
    const a = actor();
    await authService.disableMfa(a.userId, body.password, body.code, a.roleLevel, client);
    sendSuccess(res, null, { message: 'MFA disabled' });
  },

  googleStart({ res }: Ctx) {
    const { url, state, verifier } = buildGoogleAuthorization();
    res.cookie(OAUTH_COOKIE, `${state}.${verifier}`, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax', // must survive the top-level redirect back from Google
      path: `${env.API_PREFIX}/auth/google`,
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(302, url);
  },

  async googleCallback({ req, res, query, client }: Ctx<undefined, z.infer<typeof S.googleCallbackQuery>>) {
    const front = env.FRONTEND_URL.replace(/\/$/, '');
    const cookie = (req.cookies as Record<string, string | undefined>)[OAUTH_COOKIE];
    res.clearCookie(OAUTH_COOKIE, { path: `${env.API_PREFIX}/auth/google` });
    const [state, verifier] = cookie?.split('.') ?? [];
    if (query.error || !query.code || !query.state || !state || !verifier || state !== query.state) {
      res.redirect(302, `${front}/auth/callback?error=oauth_failed`);
      return;
    }
    try {
      const result = await completeGoogleLogin(query.code, verifier, client);
      if (result.kind === 'mfa') {
        res.redirect(302, `${front}/auth/mfa?mfaToken=${encodeURIComponent(result.mfaToken)}`);
        return;
      }
      setRefreshCookie(res, result.tokens.refreshToken, result.tokens.refreshTokenExpiresAt);
      // No tokens in the URL: the frontend calls POST /auth/refresh to obtain an access token.
      res.redirect(302, `${front}/auth/callback?status=ok`);
    } catch {
      res.redirect(302, `${front}/auth/callback?error=oauth_failed`);
    }
  },
};
