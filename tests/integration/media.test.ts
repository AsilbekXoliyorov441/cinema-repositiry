import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApp, prisma, publishedMovie, request, resetState, teardown, userWithToken } from '../helpers/context.js';

const api = () => request(getApp());
const storageRoot = path.resolve(process.env.LOCAL_STORAGE_PATH as string);

beforeAll(resetState);
afterAll(teardown);

async function png(width = 1400, height = 2100) {
  return sharp({ create: { width, height, channels: 3, background: '#335577' } }).png().toBuffer();
}

describe('image upload', () => {
  it('uploads a poster, stores it under a random name with variants and serves it publicly', async () => {
    const { auth } = await userWithToken({ roles: ['ADMIN'] });
    const res = await api()
      .post('/api/v1/admin/media/images')
      .set(auth)
      .field('kind', 'POSTER')
      .field('altText', 'Poster')
      .attach('file', await png(), { filename: '../../evil name.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    const media = res.body.data;
    expect(media).toMatchObject({ kind: 'POSTER', mimeType: 'image/png', width: 1400, height: 2100, originalName: 'evil name.png', visibility: 'PUBLIC' });
    expect(Object.keys(media.variants).sort()).toEqual(['lg', 'md', 'sm']);
    expect(media.checksum).toMatch(/^[a-f0-9]{64}$/);

    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.id } });
    expect(row.storageKey).toMatch(/^public\/images\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(existsSync(path.join(storageRoot, row.storageKey))).toBe(true);

    const file = await api().get(new URL(media.url).pathname);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    const meta = await api().get(`/api/v1/media/${media.id}`);
    expect(meta.body.data.url).toBe(media.url);
  });

  it('rejects spoofed files, SVG and oversized uploads', async () => {
    const { auth } = await userWithToken({ roles: ['ADMIN'] });
    const fake = await api()
      .post('/api/v1/admin/media/images')
      .set(auth)
      .attach('file', Buffer.from('<?php system($_GET["c"]); ?>'.padEnd(64, ' ')), { filename: 'shell.png', contentType: 'image/png' });
    expect(fake.status).toBe(415);
    expect(fake.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const svg = await api()
      .post('/api/v1/admin/media/images')
      .set(auth)
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(svg.status).toBe(415);

    const jpegAsPng = await api()
      .post('/api/v1/admin/media/images')
      .set(auth)
      .attach('file', await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).jpeg().toBuffer(), { filename: 'a.png', contentType: 'image/png' });
    expect(jpegAsPng.status).toBe(415);

    const missing = await api().post('/api/v1/admin/media/images').set(auth).field('kind', 'POSTER');
    expect(missing.status).toBe(400);
    expect(await prisma.mediaAsset.count({ where: { originalName: { in: ['shell.png', 'x.svg', 'a.png'] } } })).toBe(0);
  });

  it('only users with media:upload can upload; regular users get 403 before the file is parsed', async () => {
    const { auth } = await userWithToken();
    const res = await api().post('/api/v1/admin/media/images').set(auth).attach('file', await png(10, 10), { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('refuses to delete a poster that is in use, then deletes it once detached (DB + files)', async () => {
    const { auth } = await userWithToken({ roles: ['ADMIN'] });
    const up = await api().post('/api/v1/admin/media/images').set(auth).attach('file', await png(400, 600), { filename: 'p.png', contentType: 'image/png' });
    const mediaId = up.body.data.id as string;
    const movie = await publishedMovie({ posterImageId: mediaId });

    const inUse = await api().delete(`/api/v1/admin/media/${mediaId}`).set(auth);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.details[0]).toMatchObject({ path: 'movie.poster' });

    const detail = await api().get(`/api/v1/movies/${movie.slug}`);
    expect(detail.body.data.poster.id).toBe(mediaId);

    await api().patch(`/api/v1/admin/movies/${movie.id}`).set(auth).send({ posterImageId: null });
    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    const del = await api().delete(`/api/v1/admin/media/${mediaId}`).set(auth);
    expect(del.status).toBe(200);
    expect(await prisma.mediaAsset.findUnique({ where: { id: mediaId } })).toBeNull();
    expect(existsSync(path.join(storageRoot, row.storageKey))).toBe(false);
  });

  it('bulk upload reports per-file results', async () => {
    const { auth } = await userWithToken({ roles: ['ADMIN'] });
    const res = await api()
      .post('/api/v1/admin/media/images/bulk')
      .set(auth)
      .field('kind', 'BACKDROP')
      .attach('files', await png(300, 200), { filename: 'ok.png', contentType: 'image/png' })
      .attach('files', Buffer.from('garbage-content-not-an-image!!'), { filename: 'bad.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].media.kind).toBe('BACKDROP');
    expect(res.body.data[1].error).toMatch(/JPEG, PNG/);
  });

  it('private media is not exposed to the public', async () => {
    const { auth } = await userWithToken({ roles: ['ADMIN'] });
    const up = await api().post('/api/v1/admin/media/images').set(auth).field('visibility', 'PRIVATE').attach('file', await png(50, 50), { filename: 'p.png', contentType: 'image/png' });
    expect(up.body.data.url).toContain('/api/v1/media/');
    expect((await api().get(`/api/v1/media/${up.body.data.id}`)).status).toBe(404);
    expect((await api().get(`/api/v1/media/${up.body.data.id}/content`)).status).toBe(404);
    const staff = await api().get(`/api/v1/media/${up.body.data.id}/content`).set(auth);
    expect(staff.status).toBe(200);
    expect(staff.headers['cache-control']).toContain('no-store');
  });
});
