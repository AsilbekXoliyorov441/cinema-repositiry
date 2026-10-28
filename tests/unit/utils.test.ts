import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildMeta, paginationQuery, sortQuery, toSkipTake } from '../../src/common/utils/pagination.js';
import { escapeLike, searchTerm } from '../../src/common/utils/search.js';
import { isPrivateAddress } from '../../src/common/utils/url-safety.js';
import { processImage, sanitizeOriginalName, sniffImageFormat } from '../../src/modules/media/image-processing.js';
import { evaluateProgress } from '../../src/modules/watch-history/progress.policy.js';
import { signPlaybackUrl, verifySignedPlaybackUrl } from '../../src/modules/playback/signed-url.js';
import { totpAt, verifyTotp, base32Decode, base32Encode } from '../../src/modules/auth/totp.js';
import { decrypt, encrypt } from '../../src/common/utils/crypto.js';
import { slugify } from '../../src/common/utils/slug.js';

describe('pagination', () => {
  it('parses defaults and bounds', () => {
    expect(paginationQuery.parse({})).toEqual({ page: 1, limit: 20 });
    expect(paginationQuery.safeParse({ limit: '1000' }).success).toBe(false);
    expect(paginationQuery.safeParse({ page: '0' }).success).toBe(false);
  });
  it('computes skip/take and meta', () => {
    expect(toSkipTake({ page: 3, limit: 10 })).toEqual({ skip: 20, take: 10 });
    expect(buildMeta({ page: 2, limit: 10 }, 25)).toEqual({ page: 2, limit: 10, total: 25, totalPages: 3, hasNextPage: true, hasPrevPage: true });
    expect(buildMeta({ page: 1, limit: 10 }, 0).totalPages).toBe(1);
  });
  it('accepts only allowlisted sort fields', () => {
    const s = sortQuery(['title', 'createdAt'], '-createdAt');
    expect(s.parse(undefined)).toEqual({ field: 'createdAt', direction: 'desc' });
    expect(s.parse('title')).toEqual({ field: 'title', direction: 'asc' });
    expect(s.safeParse('password').success).toBe(false);
  });
});

describe('search', () => {
  it('escapes LIKE wildcards and bounds terms', () => {
    expect(escapeLike('100%_off\\')).toBe('100\\%\\_off\\\\');
    expect(searchTerm.parse('  star   wars ')).toBe('star wars');
    expect(searchTerm.safeParse('a').success).toBe(false);
    expect(searchTerm.safeParse('x'.repeat(101)).success).toBe(false);
  });
});

describe('isPrivateAddress (SSRF guard)', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'blocks %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '151.101.1.69', '2606:4700::1111'])('allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('image validation', () => {
  it('sniffs real formats and rejects SVG/text', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } }).png().toBuffer();
    expect(sniffImageFormat(png)).toBe('png');
    expect(sniffImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageFormat(Buffer.from('#!/bin/sh\necho pwned\n'))).toBeNull();
  });

  it('rejects a file whose content does not match its declared MIME type', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#0f0' } }).png().toBuffer();
    await expect(processImage(png, 'image/jpeg')).rejects.toMatchObject({ statusCode: 415 });
    await expect(processImage(Buffer.from('not an image at all, really'), 'image/png')).rejects.toMatchObject({ statusCode: 415 });
  });

  it('strips EXIF metadata and builds variants', async () => {
    const jpeg = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#123456' } })
      .withExif({ IFD0: { Copyright: 'secret-location-data' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const out = await processImage(jpeg, 'image/jpeg');
    expect((await sharp(out.buffer).metadata()).exif).toBeUndefined();
    expect(out.variants.map((v) => v.name)).toEqual(['sm', 'md', 'lg']);
    expect(out).toMatchObject({ width: 1600, height: 900, mimeType: 'image/jpeg' });
  });

  it('sanitizes original names (no paths)', () => {
    expect(sanitizeOriginalName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeOriginalName('C:\\temp\\po<ster>.png')).toBe('po_ster_.png');
  });
});

describe('progress policy', () => {
  it('uses catalog duration over client input and marks completion at 90%', () => {
    expect(evaluateProgress({ positionSeconds: 5400, clientDurationSeconds: 99999, catalogDurationSeconds: 6000 })).toEqual({
      ok: true,
      positionSeconds: 5400,
      durationSeconds: 6000,
      completed: true,
    });
  });
  it('clamps small overshoot and rejects large overshoot or negative values', () => {
    expect(evaluateProgress({ positionSeconds: 6030, catalogDurationSeconds: 6000 })).toMatchObject({ ok: true, positionSeconds: 6000 });
    expect(evaluateProgress({ positionSeconds: 9000, catalogDurationSeconds: 6000 }).ok).toBe(false);
    expect(evaluateProgress({ positionSeconds: -1, catalogDurationSeconds: 6000 }).ok).toBe(false);
    expect(evaluateProgress({ positionSeconds: 10, catalogDurationSeconds: null }).ok).toBe(false);
  });
});

describe('signed playback URLs', () => {
  it('signs and verifies with expiry', () => {
    const now = Date.now();
    const { url, expiresAt } = signPlaybackUrl('https://cdn.example.com/v/master.m3u8', 'secret', 60, now);
    expect(verifySignedPlaybackUrl(url, 'secret', now)).toBe(true);
    expect(verifySignedPlaybackUrl(url, 'other-secret', now)).toBe(false);
    expect(verifySignedPlaybackUrl(url, 'secret', expiresAt.getTime() + 1000)).toBe(false);
    expect(verifySignedPlaybackUrl(url.replace('master', 'other'), 'secret', now)).toBe(false);
  });
});

describe('TOTP and encryption', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });
  it('accepts ±1 step drift only', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const t = 1_700_000_000_000;
    const step = Math.floor(t / 30_000);
    expect(verifyTotp(secret, totpAt(secret, step - 1), t)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step - 3), t)).toBeNull();
  });
  it('round-trips AES-GCM and detects tampering', () => {
    const key = '00'.repeat(32);
    const enc = encrypt('top-secret', key);
    expect(decrypt(enc, key)).toBe('top-secret');
    const [iv, tag, ct] = enc.split('.');
    expect(() => decrypt([iv, tag, `${ct}A`].join('.'), key)).toThrow();
  });
});

describe('slugify', () => {
  it('produces url-safe slugs', () => {
    expect(slugify("O'zbekiston: Qo‘shiq — 2024!")).toBe('ozbekiston-qoshiq-2024');
    expect(slugify('Amélie')).toBe('amelie');
  });
});
