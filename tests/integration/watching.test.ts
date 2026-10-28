import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addVideo, getApp, prisma, publishedMovie, request, resetState, teardown, userWithToken } from '../helpers/context.js';

const api = () => request(getApp());

beforeAll(resetState);
afterAll(teardown);

describe('watchlist', () => {
  it('adds, lists (paginated), prevents duplicates and removes', async () => {
    const { auth } = await userWithToken();
    const m1 = await publishedMovie({ title: 'WL One' });
    const m2 = await publishedMovie({ title: 'WL Two' });
    expect((await api().post('/api/v1/me/watchlist').set(auth).send({ movieId: m1.id })).status).toBe(201);
    expect((await api().post('/api/v1/me/watchlist').set(auth).send({ movieId: m2.id })).status).toBe(201);
    const dup = await api().post('/api/v1/me/watchlist').set(auth).send({ movieId: m1.id });
    expect(dup.status).toBe(409);

    const list = await api().get('/api/v1/me/watchlist').set(auth).query({ limit: 1 });
    expect(list.body.meta).toMatchObject({ total: 2, totalPages: 2 });
    expect(list.body.data[0]).toMatchObject({ type: 'movie', movie: { title: 'WL Two' } });

    const detail = await api().get(`/api/v1/movies/${m1.slug}`).set(auth);
    expect(detail.body.data.viewer.inWatchlist).toBe(true);

    expect((await api().delete(`/api/v1/me/watchlist/movies/${m1.id}`).set(auth)).status).toBe(200);
    expect((await api().delete(`/api/v1/me/watchlist/movies/${m1.id}`).set(auth)).status).toBe(404);
  });

  it('cannot add unpublished movies and requires exactly one target', async () => {
    const { auth } = await userWithToken();
    const draft = await prisma.movie.create({ data: { title: 'Draft', slug: 'draft-wl', status: 'DRAFT' } });
    expect((await api().post('/api/v1/me/watchlist').set(auth).send({ movieId: draft.id })).status).toBe(404);
    expect((await api().post('/api/v1/me/watchlist').set(auth).send({})).status).toBe(422);
  });
});

describe('progress and history', () => {
  it('saves progress using the catalog runtime, completes at 90% and feeds continue-watching', async () => {
    const { auth } = await userWithToken();
    const movie = await publishedMovie({ title: 'Progress Movie', durationMinutes: 100 });

    const saved = await api().put(`/api/v1/me/progress/${movie.id}`).set(auth).send({ positionSeconds: 1200, durationSeconds: 99999 });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ positionSeconds: 1200, durationSeconds: 6000, completed: false });

    const cw = await api().get('/api/v1/me/continue-watching').set(auth);
    expect(cw.body.data[0]).toMatchObject({ content: { type: 'movie', id: movie.id }, percent: 20 });

    const invalid = await api().put(`/api/v1/me/progress/${movie.id}`).set(auth).send({ positionSeconds: 20000 });
    expect(invalid.status).toBe(422);

    await prisma.watchProgress.updateMany({ data: { updatedAt: new Date(Date.now() - 60_000) } });
    const done = await api().put(`/api/v1/me/progress/${movie.id}`).set(auth).send({ positionSeconds: 5500 });
    expect(done.body.data.completed).toBe(true);
    const cwAfter = await api().get('/api/v1/me/continue-watching').set(auth);
    expect(cwAfter.body.data.find((c: { content: { id: string } }) => c.content.id === movie.id)).toBeUndefined();
  });

  it('progress is private: another user sees nothing and cannot delete foreign history (IDOR)', async () => {
    const alice = await userWithToken();
    const bob = await userWithToken();
    const movie = await publishedMovie({ title: 'Private Progress' });
    await addVideo(movie.id);
    await api().put(`/api/v1/me/progress/${movie.id}`).set(alice.auth).send({ positionSeconds: 300 });
    await api().get(`/api/v1/playback/${movie.id}`).set(alice.auth);

    const bobView = await api().get(`/api/v1/me/progress/${movie.id}`).set(bob.auth);
    expect(bobView.status).toBe(200);
    expect(bobView.body.data).toBeNull();
    expect((await api().get('/api/v1/me/continue-watching').set(bob.auth)).body.data).toHaveLength(0);

    const aliceHistory = await api().get('/api/v1/me/history').set(alice.auth);
    expect(aliceHistory.body.data).toHaveLength(1);
    const entryId = aliceHistory.body.data[0].id as string;
    expect((await api().delete(`/api/v1/me/history/${entryId}`).set(bob.auth)).status).toBe(404);
    expect(await prisma.watchHistory.count({ where: { id: entryId } })).toBe(1);
  });

  it('counts one view per user per day', async () => {
    const { auth } = await userWithToken();
    const movie = await publishedMovie({ title: 'Views' });
    await addVideo(movie.id);
    await api().get(`/api/v1/playback/${movie.id}`).set(auth);
    await api().get(`/api/v1/playback/${movie.id}`).set(auth);
    expect((await prisma.movie.findUniqueOrThrow({ where: { id: movie.id } })).viewCount).toBe(1);
  });
});

describe('ratings and reviews', () => {
  it('keeps one rating per user and recomputes aggregates exactly', async () => {
    const movie = await publishedMovie({ title: 'Rated' });
    const users = await Promise.all([userWithToken(), userWithToken(), userWithToken()]);
    await Promise.all(users.map((u, i) => api().put(`/api/v1/movies/${movie.id}/rating`).set(u.auth).send({ score: [6, 8, 10][i] })));
    await api().put(`/api/v1/movies/${movie.id}/rating`).set(users[0]!.auth).send({ score: 9 }); // update, not a new vote
    const m = await prisma.movie.findUniqueOrThrow({ where: { id: movie.id } });
    expect({ count: m.ratingCount, sum: m.ratingSum }).toEqual({ count: 3, sum: 27 });
    expect(m.ratingAvg).toBe(9);
    const removed = await api().delete(`/api/v1/movies/${movie.id}/rating`).set(users[2]!.auth);
    expect(removed.body.data).toEqual({ myRating: null, average: 8.5, count: 2 });
    expect((await api().put(`/api/v1/movies/${movie.id}/rating`).set(users[0]!.auth).send({ score: 11 })).status).toBe(422);
  });

  it('review flow: write, duplicate blocked, report, moderator hides with log, author notified', async () => {
    const movie = await publishedMovie({ title: 'Reviewed' });
    const author = await userWithToken();
    const reporter = await userWithToken();
    const moderator = await userWithToken({ roles: ['MODERATOR'] });
    const unverified = await userWithToken({ verified: false });

    expect((await api().post(`/api/v1/movies/${movie.id}/reviews`).set(unverified.auth).send({ body: 'This is a long enough review.' })).status).toBe(403);
    const created = await api().post(`/api/v1/movies/${movie.id}/reviews`).set(author.auth).send({ body: 'Great movie, highly recommended!' });
    expect(created.status).toBe(201);
    expect((await api().post(`/api/v1/movies/${movie.id}/reviews`).set(author.auth).send({ body: 'Second review attempt here.' })).status).toBe(409);
    const reviewId = created.body.data.id as string;

    expect((await api().patch(`/api/v1/reviews/${reviewId}`).set(reporter.auth).send({ body: 'hijacked review text!!' })).status).toBe(404);
    expect((await api().post(`/api/v1/reviews/${reviewId}/report`).set(author.auth).send({ reason: 'SPAM' })).status).toBe(400);
    expect((await api().post(`/api/v1/reviews/${reviewId}/report`).set(reporter.auth).send({ reason: 'SPAM' })).status).toBe(201);
    expect((await api().post(`/api/v1/reviews/${reviewId}/report`).set(reporter.auth).send({ reason: 'SPAM' })).status).toBe(409);

    const hidden = await api().post(`/api/v1/admin/reviews/${reviewId}/hide`).set(moderator.auth).send({ reason: 'Spam content' });
    expect(hidden.body.data).toMatchObject({ status: 'HIDDEN', reportCount: 1 });
    expect((await api().get(`/api/v1/movies/${movie.id}/reviews`)).body.data).toHaveLength(0);
    const log = await api().get(`/api/v1/admin/reviews/${reviewId}/moderation-log`).set(moderator.auth);
    expect(log.body.data[0]).toMatchObject({ action: 'HIDE', reason: 'Spam content' });
    expect(await prisma.notification.count({ where: { userId: author.user.id, type: 'REVIEW_HIDDEN' } })).toBe(1);
  });
});
