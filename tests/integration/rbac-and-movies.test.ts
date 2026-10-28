import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApp, prisma, publishedMovie, request, resetState, teardown, userWithToken } from '../helpers/context.js';

const api = () => request(getApp());

beforeAll(resetState);
afterAll(teardown);

describe('access control', () => {
  it('a regular user cannot reach admin endpoints', async () => {
    const { auth } = await userWithToken();
    for (const [method, path] of [
      ['get', '/api/v1/admin/users'],
      ['post', '/api/v1/admin/movies'],
      ['get', '/api/v1/admin/dashboard'],
      ['get', '/api/v1/admin/audit-logs'],
      ['get', '/api/v1/admin/payments'],
    ] as const) {
      const res = await api()[method](path).set(auth).send({ title: 'x' });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('guests get 401 on protected endpoints', async () => {
    expect((await api().get('/api/v1/admin/users')).status).toBe(401);
    expect((await api().get('/api/v1/me/watchlist')).status).toBe(401);
  });

  it('a moderator can moderate but cannot change payment settings, refunds or users', async () => {
    const { auth } = await userWithToken({ roles: ['MODERATOR'] });
    expect((await api().get('/api/v1/admin/reviews').set(auth)).status).toBe(200);
    expect((await api().put('/api/v1/admin/settings/payments.enabledProviders').set(auth).send({ value: ['STRIPE'] })).status).toBe(403);
    expect((await api().get('/api/v1/admin/payments').set(auth)).status).toBe(403);
    expect((await api().post('/api/v1/admin/payments/00000000-0000-0000-0000-000000000000/refund').set(auth).send({ reason: 'test' })).status).toBe(403);
    expect((await api().get('/api/v1/admin/subscriptions').set(auth)).status).toBe(403);
  });

  it('an admin cannot change payment-provider settings (super admin only)', async () => {
    const { auth } = await userWithToken({ roles: ['ADMIN'] });
    expect((await api().put('/api/v1/admin/settings/payments.enabledProviders').set(auth).send({ value: ['STRIPE'] })).status).toBe(403);
  });

  it('a super admin can change settings, and the change is audited', async () => {
    const { auth, user } = await userWithToken({ roles: ['SUPER_ADMIN'] });
    const res = await api().put('/api/v1/admin/settings/reviews.requireWatched').set(auth).send({ value: false });
    expect(res.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { actorId: user.id, action: 'settings.update', severity: 'HIGH' } })).toBe(1);
  });

  it('blocks privilege escalation', async () => {
    const admin = await userWithToken({ roles: ['ADMIN'] });
    const peer = await userWithToken({ roles: ['ADMIN'] });
    const victim = await userWithToken();

    // cannot promote anyone (or self) to ADMIN/SUPER_ADMIN — level must be below own
    expect((await api().put(`/api/v1/admin/users/${victim.user.id}/roles`).set(admin.auth).send({ roles: ['ADMIN'] })).status).toBe(403);
    expect((await api().put(`/api/v1/admin/users/${admin.user.id}/roles`).set(admin.auth).send({ roles: ['SUPER_ADMIN'] })).status).toBe(403);
    // cannot ban self or a peer admin
    expect((await api().post(`/api/v1/admin/users/${admin.user.id}/ban`).set(admin.auth).send({ reason: 'self' })).status).toBe(403);
    expect((await api().post(`/api/v1/admin/users/${peer.user.id}/ban`).set(admin.auth).send({ reason: 'peer' })).status).toBe(403);
    // cannot create a role above own level or grant permissions it does not hold
    expect((await api().post('/api/v1/admin/roles').set(admin.auth).send({ name: 'BOSS', level: 90, permissions: [] })).status).toBe(403);

    // allowed: promote a user to MODERATOR → target is signed out
    const ok = await api().put(`/api/v1/admin/users/${victim.user.id}/roles`).set(admin.auth).send({ roles: ['MODERATOR'] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.roles.sort()).toEqual(['MODERATOR', 'USER']);
    expect((await api().get('/api/v1/me').set(victim.auth)).status).toBe(401);
  });

  it('banning a user revokes their sessions immediately', async () => {
    const admin = await userWithToken({ roles: ['ADMIN'] });
    const target = await userWithToken();
    const res = await api().post(`/api/v1/admin/users/${target.user.id}/ban`).set(admin.auth).send({ reason: 'spam' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'BANNED', statusReason: 'spam' });
    expect((await api().get('/api/v1/me').set(target.auth)).status).toBe(401);
  });
});

describe('movie CRUD and catalog visibility', () => {
  it('admin creates a draft that is hidden until published, then publishes, updates and deletes it', async () => {
    const { auth } = await userWithToken({ roles: ['ADMIN'] });
    const genre = await prisma.genre.findFirstOrThrow({ where: { slug: 'drama' } });

    const created = await api()
      .post('/api/v1/admin/movies')
      .set(auth)
      .send({ title: 'The Long Night', releaseDate: '2024-05-01', durationMinutes: 120, accessTier: 'PRO', genreIds: [genre.id], country: 'US', language: 'en' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ slug: 'the-long-night', status: 'DRAFT', releaseYear: 2024, accessTier: 'PRO', genres: [{ slug: 'drama' }] });
    const id = created.body.data.id as string;

    expect((await api().get('/api/v1/movies/the-long-night')).status).toBe(404);
    const listBefore = await api().get('/api/v1/movies').query({ q: 'Long Night' });
    expect(listBefore.body.data).toHaveLength(0);

    const published = await api().post(`/api/v1/admin/movies/${id}/publish`).set(auth);
    expect(published.body.data.status).toBe('PUBLISHED');
    expect(published.body.data.publishedAt).not.toBeNull();

    const detail = await api().get('/api/v1/movies/the-long-night');
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ title: 'The Long Night', viewer: null });
    expect(JSON.stringify(detail.body.data)).not.toContain('playbackUrl');

    // cache invalidation: list reflects the update right away
    const listAfter = await api().get('/api/v1/movies').query({ q: 'long night', genre: 'drama', year: 2024 });
    expect(listAfter.body.data.map((m: { id: string }) => m.id)).toEqual([id]);
    await api().patch(`/api/v1/admin/movies/${id}`).set(auth).send({ title: 'The Longest Night' });
    const renamed = await api().get('/api/v1/movies').query({ q: 'longest' });
    expect(renamed.body.data[0].title).toBe('The Longest Night');

    expect((await api().delete(`/api/v1/admin/movies/${id}`).set(auth)).status).toBe(200);
    expect((await api().get(`/api/v1/movies/${id}`)).status).toBe(404);
    expect((await prisma.movie.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
    expect((await api().post(`/api/v1/admin/movies/${id}/restore`).set(auth)).body.data.status).toBe('DRAFT');
  });

  it('validates input and rejects unknown genres, bad URLs and javascript: trailers', async () => {
    const { auth } = await userWithToken({ roles: ['ADMIN'] });
    const res = await api()
      .post('/api/v1/admin/movies')
      .set(auth)
      .send({ title: '', trailerUrl: 'javascript:alert(1)', genreIds: ['not-a-uuid'] });
    expect(res.status).toBe(422);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['body.title', 'body.genreIds.0']));
    expect(paths.some((p: string) => p.startsWith('body.trailerUrl'))).toBe(true);
    const ssrf = await api().post('/api/v1/admin/movies').set(auth).send({ title: 'X', trailerUrl: 'http://169.254.169.254/latest' });
    expect(ssrf.status).toBe(422);
  });

  it('paginates, sorts and searches safely', async () => {
    for (let i = 0; i < 5; i++) await publishedMovie({ title: `Paged ${i}`, ratingAvg: i });
    const page = await api().get('/api/v1/movies').query({ q: 'Paged', limit: 2, page: 2, sort: '-rating' });
    expect(page.body.meta).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3, hasNextPage: true, hasPrevPage: true });
    expect(page.body.data.map((m: { title: string }) => m.title)).toEqual(['Paged 2', 'Paged 1']);
    const wildcard = await api().get('/api/v1/movies').query({ q: '%%' });
    expect(wildcard.body.data).toHaveLength(0);
    expect((await api().get('/api/v1/movies').query({ sort: 'passwordHash' })).status).toBe(422);
    expect((await api().get('/api/v1/movies').query({ limit: 500 })).status).toBe(422);
  });

  it('serves shelves and similar movies', async () => {
    const trending = await api().get('/api/v1/movies/trending').query({ limit: 3 });
    expect(trending.status).toBe(200);
    expect(trending.body.data.length).toBeLessThanOrEqual(3);
    const genres = await api().get('/api/v1/genres');
    expect(genres.body.data.find((g: { slug: string }) => g.slug === 'animation').movieCount).toBeGreaterThan(0);
    const similar = await api().get('/api/v1/movies/big-buck-bunny/similar');
    expect(similar.body.data.map((m: { slug: string }) => m.slug)).toContain('sintel');
  });
});
