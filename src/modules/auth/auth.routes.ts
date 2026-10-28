import { z } from 'zod';
import { ApiRouter } from '../../common/http/api-router.js';
import { rateLimiters } from '../../common/middleware/rate-limit.js';
import { cookieCsrfGuard } from '../../common/middleware/csrf.js';
import { userProfileSchema } from '../users/users.mapper.js';
import { authController as c } from './auth.controller.js';
import * as S from './auth.schemas.js';

const api = new ApiRouter('Auth');

const csrfNote = 'Cookie-authenticated: requires the `X-Requested-With` header and an allowlisted Origin (CSRF protection).';

api
  .route({
    method: 'post',
    path: '/auth/register',
    summary: 'Register a new account',
    description: 'Creates a USER account, sends a verification email and starts a session (refresh token set as HttpOnly cookie).',
    rateLimit: rateLimiters.auth,
    body: S.registerBody,
    response: S.authTokensResponse,
    responseStatus: 201,
    errors: [409],
    handler: c.register,
  })
  .route({
    method: 'post',
    path: '/auth/login',
    summary: 'Log in with email and password',
    description: 'Returns an access token, or `mfaRequired: true` with a challenge token when MFA is enabled.',
    rateLimit: rateLimiters.login,
    body: S.loginBody,
    response: S.loginResponse,
    errors: [401, 403],
    handler: c.login,
  })
  .route({
    method: 'post',
    path: '/auth/mfa/verify',
    summary: 'Complete login with a TOTP code',
    rateLimit: rateLimiters.login,
    body: S.mfaLoginBody,
    response: S.authTokensResponse,
    errors: [401],
    handler: c.verifyMfaLogin,
  })
  .route({
    method: 'post',
    path: '/auth/refresh',
    summary: 'Rotate the refresh token and get a new access token',
    description: `${csrfNote} Each refresh token is single-use; replaying a used token revokes the whole session.`,
    rateLimit: rateLimiters.refresh,
    before: [cookieCsrfGuard],
    body: S.refreshBody,
    response: S.refreshResponse,
    extraSecurity: [{ refreshCookie: [] }],
    errors: [401, 403],
    handler: c.refresh,
  })
  .route({
    method: 'post',
    path: '/auth/logout',
    summary: 'Log out the current session',
    description: csrfNote,
    before: [cookieCsrfGuard],
    body: S.refreshBody,
    response: null,
    extraSecurity: [{ refreshCookie: [] }],
    handler: c.logout,
  })
  .route({
    method: 'post',
    path: '/auth/logout-all',
    summary: 'Log out from every session',
    auth: 'user',
    response: z.object({ revokedSessions: z.number().int() }),
    handler: c.logoutAll,
  })
  .route({
    method: 'get',
    path: '/auth/me',
    summary: 'Current user profile',
    auth: 'user',
    response: userProfileSchema,
    handler: c.me,
  })
  .route({
    method: 'post',
    path: '/auth/verify-email',
    summary: 'Confirm email address with the token from the email',
    rateLimit: rateLimiters.auth,
    body: S.tokenBody,
    response: null,
    errors: [400],
    handler: c.verifyEmail,
  })
  .route({
    method: 'post',
    path: '/auth/resend-verification',
    summary: 'Resend the verification email',
    auth: 'user',
    rateLimit: rateLimiters.emailSend,
    response: null,
    errors: [409],
    handler: c.resendVerification,
  })
  .route({
    method: 'post',
    path: '/auth/forgot-password',
    summary: 'Request a password reset email',
    description: 'Always returns 200 to avoid revealing which emails are registered.',
    rateLimit: rateLimiters.emailSend,
    body: S.emailBody,
    response: null,
    handler: c.forgotPassword,
  })
  .route({
    method: 'post',
    path: '/auth/reset-password',
    summary: 'Set a new password with a reset token',
    description: 'Tokens are single-use and expire after 30 minutes. All sessions are revoked.',
    rateLimit: rateLimiters.auth,
    body: S.resetPasswordBody,
    response: null,
    errors: [400],
    handler: c.resetPassword,
  })
  .route({
    method: 'post',
    path: '/auth/change-password',
    summary: 'Change password (signs out other sessions)',
    auth: 'user',
    rateLimit: rateLimiters.auth,
    body: S.changePasswordBody,
    response: null,
    errors: [400],
    handler: c.changePassword,
  })
  .route({
    method: 'post',
    path: '/auth/email/change',
    summary: 'Request an email change (confirmation sent to the new address)',
    auth: 'user',
    rateLimit: rateLimiters.emailSend,
    body: S.emailChangeBody,
    response: null,
    errors: [400, 409],
    handler: c.requestEmailChange,
  })
  .route({
    method: 'post',
    path: '/auth/email/confirm',
    summary: 'Confirm an email change',
    rateLimit: rateLimiters.auth,
    body: S.tokenBody,
    response: null,
    errors: [400, 409],
    handler: c.confirmEmailChange,
  })
  .route({
    method: 'get',
    path: '/auth/sessions',
    summary: 'List active sessions',
    auth: 'user',
    response: z.array(S.sessionSchema),
    handler: c.sessions,
  })
  .route({
    method: 'delete',
    path: '/auth/sessions/:id',
    summary: 'Revoke one of your sessions',
    auth: 'user',
    params: S.sessionIdParam,
    response: null,
    errors: [404],
    handler: c.revokeSession,
  })
  .route({
    method: 'post',
    path: '/auth/sessions/revoke-others',
    summary: 'Revoke all sessions except the current one',
    auth: 'user',
    response: z.object({ revokedSessions: z.number().int() }),
    handler: c.revokeOtherSessions,
  })
  .route({
    method: 'post',
    path: '/auth/mfa/setup',
    summary: 'Start TOTP MFA setup (returns secret and otpauth URL)',
    auth: 'user',
    response: S.mfaSetupResponse,
    errors: [409],
    handler: c.mfaSetup,
  })
  .route({
    method: 'post',
    path: '/auth/mfa/enable',
    summary: 'Enable MFA by confirming a TOTP code',
    auth: 'user',
    rateLimit: rateLimiters.auth,
    body: S.mfaCodeBody,
    response: null,
    errors: [400, 401, 409],
    handler: c.mfaEnable,
  })
  .route({
    method: 'post',
    path: '/auth/mfa/disable',
    summary: 'Disable MFA (password + TOTP code required)',
    auth: 'user',
    rateLimit: rateLimiters.auth,
    body: S.mfaDisableBody,
    response: null,
    errors: [400, 401],
    handler: c.mfaDisable,
  })
  .route({
    method: 'get',
    path: '/auth/google',
    summary: 'Start Google sign-in (redirect)',
    description: 'Available only when GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI are configured. Uses state + PKCE.',
    rateLimit: rateLimiters.auth,
    rawResponse: { contentType: 'text/plain', description: 'Redirect to Google' },
    responseStatus: 302,
    errors: [404],
    handler: c.googleStart,
  })
  .route({
    method: 'get',
    path: '/auth/google/callback',
    summary: 'Google OAuth callback (redirects to the frontend)',
    query: S.googleCallbackQuery,
    rawResponse: { contentType: 'text/plain', description: 'Redirect to FRONTEND_URL/auth/callback' },
    responseStatus: 302,
    handler: c.googleCallback,
  });

export const authRouter = api.router;
