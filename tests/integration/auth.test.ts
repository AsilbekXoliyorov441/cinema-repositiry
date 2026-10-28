import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, getApp, lastEmailToken, login, prisma, request, resetState, teardown } from '../helpers/context.js';

const api = () => request(getApp());
const csrf = { 'X-Requested-With': 'XMLHttpRequest' };

beforeAll(resetState);
afterAll(teardown);

describe('register & login', () => {
  it('registers, returns an access token, sets an HttpOnly refresh cookie and queues a verification email', async () => {
    const res = await api().post('/api/v1/auth/register').send({ email: 'New.User@Example.com', password: 'Secret123', displayName: 'New User' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ tokenType: 'Bearer', user: { email: 'new.user@example.com', emailVerified: false, roles: ['USER'] } });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('cw_refresh='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'new.user@example.com' } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(lastEmailToken('verify-email', 'new.user@example.com')).resolves.toHaveLength(43);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const dup = await api().post('/api/v1/auth/register').send({ email: 'new.user@example.com', password: 'Secret123', displayName: 'Again' });
    expect(dup.status).toBe(409);
    const weak = await api().post('/api/v1/auth/register').send({ email: 'weak@example.com', password: 'short', displayName: 'Weak' });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    expect(weak.body.error.details[0].path).toBe('body.password');
  });

  it('returns the same error for unknown email and wrong password (no account enumeration)', async () => {
    const unknown = await api().post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'Whatever1' });
    const wrong = await api().post('/api/v1/auth/login').send({ email: 'new.user@example.com', password: 'Wrong1234' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body).toMatchObject({ message: unknown.body.message, error: { code: unknown.body.error.code } });
  });

  it('verifies email with a single-use token', async () => {
    const token = await lastEmailToken('verify-email', 'new.user@example.com');
    expect((await api().post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'new.user@example.com' } })).emailVerifiedAt).not.toBeNull();
    expect((await api().post('/api/v1/auth/verify-email').send({ token })).status).toBe(400);
  });
});

describe('refresh token rotation', () => {
  it('rotates tokens and revokes the session when an old refresh token is replayed', async () => {
    const user = await createUser();
    const { cookie } = await login(user.email);

    const first = await api().post('/api/v1/auth/refresh').set(csrf).set('Cookie', cookie);
    expect(first.status).toBe(200);
    expect(first.body.data.accessToken).toEqual(expect.any(String));
    const rotated = ([] as string[]).concat(first.headers['set-cookie'] ?? []).find((c) => c.startsWith('cw_refresh='))!.split(';')[0]!;
    expect(rotated).not.toBe(cookie);

    // Replay of the already-used token → reuse detected → whole session revoked.
    const replay = await api().post('/api/v1/auth/refresh').set(csrf).set('Cookie', cookie);
    expect(replay.status).toBe(401);
    const afterReuse = await api().post('/api/v1/auth/refresh').set(csrf).set('Cookie', rotated);
    expect(afterReuse.status).toBe(401);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'auth.refresh_token_reuse', actorId: user.id } });
    expect(audit?.severity).toBe('HIGH');
  });

  it('requires the CSRF header and an allowlisted Origin for cookie-based refresh', async () => {
    const user = await createUser();
    const { cookie } = await login(user.email);
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(403);
    expect((await api().post('/api/v1/auth/refresh').set(csrf).set('Origin', 'https://evil.example').set('Cookie', cookie)).status).toBe(403);
    expect((await api().post('/api/v1/auth/refresh').set(csrf).set('Origin', 'http://localhost:3000').set('Cookie', cookie)).status).toBe(200);
  });
});

describe('logout', () => {
  it('revokes the session so the access token stops working immediately', async () => {
    const user = await createUser();
    const { token, cookie } = await login(user.email);
    expect((await api().get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const out = await api().post('/api/v1/auth/logout').set(csrf).set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect((await api().get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await api().post('/api/v1/auth/refresh').set(csrf).set('Cookie', cookie)).status).toBe(401);
  });
});

describe('password reset', () => {
  it('always answers 200, resets with a single-use token and signs out all sessions', async () => {
    const user = await createUser({ email: 'reset@test.local' });
    const { token: oldAccess } = await login(user.email);

    const unknown = await api().post('/api/v1/auth/forgot-password').send({ email: 'ghost@test.local' });
    const known = await api().post('/api/v1/auth/forgot-password').send({ email: 'reset@test.local' });
    expect(unknown.status).toBe(200);
    expect(known.body.message).toBe(unknown.body.message);

    const token = await lastEmailToken('password-reset', 'reset@test.local');
    const reset = await api().post('/api/v1/auth/reset-password').send({ token, password: 'BrandNew123' });
    expect(reset.status).toBe(200);
    expect((await api().post('/api/v1/auth/reset-password').send({ token, password: 'Another123' })).status).toBe(400);
    expect((await api().get('/api/v1/me').set('Authorization', `Bearer ${oldAccess}`)).status).toBe(401);
    await expect(login('reset@test.local', 'Password123')).rejects.toThrow();
    await expect(login('reset@test.local', 'BrandNew123')).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('rejects expired reset tokens', async () => {
    await createUser({ email: 'expired@test.local' });
    await api().post('/api/v1/auth/forgot-password').send({ email: 'expired@test.local' });
    const token = await lastEmailToken('password-reset', 'expired@test.local');
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) }, where: { user: { email: 'expired@test.local' } } });
    expect((await api().post('/api/v1/auth/reset-password').send({ token, password: 'BrandNew123' })).status).toBe(400);
  });
});

describe('blocked accounts', () => {
  it('a banned user cannot log in, and existing tokens stop working', async () => {
    const user = await createUser();
    const { token } = await login(user.email);
    await prisma.user.update({ where: { id: user.id }, data: { status: 'BANNED' } });
    const me = await api().get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('ACCOUNT_DISABLED');
    const again = await api().post('/api/v1/auth/login').send({ email: user.email, password: 'Password123' });
    expect(again.status).toBe(403);
  });

  it('rejects tampered and malformed access tokens', async () => {
    const user = await createUser();
    const { token } = await login(user.email);
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa');
    expect((await api().get('/api/v1/me').set('Authorization', `Bearer ${tampered}`)).status).toBe(401);
    expect((await api().get('/api/v1/me').set('Authorization', 'Token abc')).status).toBe(401);
  });
});

describe('sessions', () => {
  it('lists own sessions and cannot revoke someone else’s session (IDOR)', async () => {
    const a = await createUser();
    const b = await createUser();
    const sa = await login(a.email);
    await login(b.email);
    const list = await api().get('/api/v1/auth/sessions').set('Authorization', `Bearer ${sa.token}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].current).toBe(true);
    const bSession = await prisma.session.findFirstOrThrow({ where: { userId: b.id } });
    expect((await api().delete(`/api/v1/auth/sessions/${bSession.id}`).set('Authorization', `Bearer ${sa.token}`)).status).toBe(404);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: bSession.id } })).revokedAt).toBeNull();
  });
});
