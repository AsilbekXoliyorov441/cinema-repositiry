import type { Express } from 'express';
import request from 'supertest';
import { prisma } from '../../src/config/database.js';
import { redis } from '../../src/config/redis.js';
import { createApp } from '../../src/app.js';
import { seed } from '../../src/cli/seed.js';
import { closeQueues, getQueue, QUEUE_NAMES } from '../../src/jobs/queues.js';
import { hashPassword } from '../../src/modules/auth/password.service.js';

let app: Express | undefined;
export function getApp(): Express {
  app ??= createApp();
  return app;
}

/** Truncates every table (keeps migrations), flushes the test Redis DB and re-seeds roles/plans/demo data. */
export async function resetState(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await redis.flushdb();
  // The seed reports progress via console.log; keep test output clean.
  // eslint-disable-next-line no-console
  const original = console.log;
  // eslint-disable-next-line no-console
  console.log = () => undefined;
  try {
    await seed(prisma, 'test');
  } finally {
    // eslint-disable-next-line no-console
    console.log = original;
  }
}

export async function teardown(): Promise<void> {
  await closeQueues();
}

let cachedHash: string | undefined;

export async function createUser(opts: { email?: string; roles?: string[]; verified?: boolean; birthDate?: Date | null; password?: string } = {}) {
  const email = opts.email ?? `user-${Math.random().toString(36).slice(2, 10)}@test.local`;
  const passwordHash = opts.password ? await hashPassword(opts.password) : (cachedHash ??= await hashPassword('Password123'));
  const roleNames = [...new Set(['USER', ...(opts.roles ?? [])])];
  const roles = await prisma.role.findMany({ where: { name: { in: roleNames } } });
  return prisma.user.create({
    data: {
      email,
      displayName: email.split('@')[0] as string,
      passwordHash,
      emailVerifiedAt: opts.verified === false ? null : new Date(),
      birthDate: opts.birthDate === undefined ? new Date('1990-01-01') : opts.birthDate,
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
    },
  });
}

export async function login(email: string, password = 'Password123') {
  const res = await request(getApp()).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('cw_refresh='));
  return { token: res.body.data.accessToken as string, cookie: cookie?.split(';')[0] as string, body: res.body };
}

export async function userWithToken(opts: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser(opts);
  const { token, cookie } = await login(user.email);
  return { user, token, cookie, auth: { Authorization: `Bearer ${token}` } };
}

/** Reads queued emails (the worker is not running in tests) to extract one-time tokens. */
export async function lastEmailToken(template: string, to: string): Promise<string> {
  const jobs = await getQueue(QUEUE_NAMES.EMAIL).getJobs(['waiting', 'delayed', 'prioritized']);
  const job = jobs.filter((j) => j.name === template && j.data.to === to).sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!job) throw new Error(`No ${template} email for ${to}`);
  return job.data.data.token as string;
}

export async function publishedMovie(overrides: Record<string, unknown> = {}) {
  return prisma.movie.create({
    data: {
      title: 'Test Movie',
      slug: `test-movie-${Math.random().toString(36).slice(2, 8)}`,
      status: 'PUBLISHED',
      publishedAt: new Date(Date.now() - 1000),
      durationMinutes: 100,
      ...overrides,
    },
  });
}

export async function addVideo(movieId: string, extra: Record<string, unknown> = {}) {
  return prisma.videoAsset.create({
    data: { movieId, provider: 'EXTERNAL', manifestType: 'HLS', playbackUrl: 'https://cdn.example.com/movie/master.m3u8', qualityLabel: '1080p', isDefault: true, ...extra },
  });
}

export { prisma, request };
