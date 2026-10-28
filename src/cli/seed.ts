import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_ROLE_DEFINITIONS,
  PERMISSION_DESCRIPTIONS,
  SYSTEM_ROLES,
  type Permission,
} from '../common/constants/permissions.js';
import { PLAN_FEATURES } from '../common/constants/features.js';
import { hashPassword } from '../modules/auth/password.service.js';

/**
 * Idempotent seed: safe to run repeatedly (upserts by natural keys).
 *  - always: permissions, system roles, role→permission mapping, default plans
 *  - development/test only: demo genres, demo movies and demo users
 *    (also in production when SEED_DEMO_DATA=true: public practice API with shared demo logins).
 *    Re-running resets the demo passwords and roles in case someone changed them.
 */
export async function seed(prisma: PrismaClient, nodeEnv: string): Promise<void> {
  // Permissions
  for (const [key, description] of Object.entries(PERMISSION_DESCRIPTIONS)) {
    await prisma.permission.upsert({ where: { key }, create: { key, description }, update: { description } });
  }
  const permissions = await prisma.permission.findMany();
  const permissionId = new Map(permissions.map((p) => [p.key, p.id]));

  // System roles with their default permissions (re-synced on every run)
  for (const [name, def] of Object.entries(DEFAULT_ROLE_DEFINITIONS)) {
    const role = await prisma.role.upsert({
      where: { name },
      create: { name, description: def.description, level: def.level, isSystem: true },
      update: { description: def.description, level: def.level, isSystem: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.permissions.map((p: Permission) => ({ roleId: role.id, permissionId: permissionId.get(p) as string })),
      skipDuplicates: true,
    });
  }
  console.log(`✔ ${permissions.length} permissions, ${Object.keys(DEFAULT_ROLE_DEFINITIONS).length} roles`);

  // Plans (created once; prices are then managed from the admin panel, never overwritten here)
  const plans = [
    { slug: 'free', name: 'Free', priceMinor: 0, billingInterval: 'MONTH' as const, intervalCount: 1, features: [], sortOrder: 0, description: 'Free movies with a CineWave account' },
    { slug: 'pro-monthly', name: 'Pro Monthly', priceMinor: 799, billingInterval: 'MONTH' as const, intervalCount: 1, features: [PLAN_FEATURES.PRO_CONTENT, PLAN_FEATURES.HD_QUALITY, PLAN_FEATURES.NO_ADS], sortOrder: 1, description: 'All Pro titles, billed monthly' },
    { slug: 'pro-quarterly', name: 'Pro Quarterly', priceMinor: 2099, billingInterval: 'MONTH' as const, intervalCount: 3, features: [PLAN_FEATURES.PRO_CONTENT, PLAN_FEATURES.HD_QUALITY, PLAN_FEATURES.NO_ADS], sortOrder: 2, description: 'All Pro titles, billed every 3 months' },
    { slug: 'pro-yearly', name: 'Pro Yearly', priceMinor: 7499, billingInterval: 'YEAR' as const, intervalCount: 1, features: [PLAN_FEATURES.PRO_CONTENT, PLAN_FEATURES.HD_QUALITY, PLAN_FEATURES.NO_ADS, PLAN_FEATURES.MULTI_DEVICE], sortOrder: 3, description: 'All Pro titles, billed yearly' },
  ];
  for (const plan of plans) {
    await prisma.subscriptionPlan.upsert({ where: { slug: plan.slug }, create: { ...plan, currency: 'USD' }, update: {} });
  }
  console.log(`✔ ${plans.length} plans`);

  if (nodeEnv === 'production' && process.env.SEED_DEMO_DATA !== 'true') {
    console.log('ℹ production: demo data and demo users skipped (set SEED_DEMO_DATA=true to add them)');
    return;
  }

  const genres = ['Action', 'Comedy', 'Drama', 'Sci-Fi', 'Thriller', 'Animation', 'Documentary', 'Horror'];
  for (const name of genres) {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '-');
    await prisma.genre.upsert({ where: { slug }, create: { name, slug }, update: {} });
  }
  const genreBySlug = new Map((await prisma.genre.findMany()).map((g) => [g.slug, g.id]));

  // Demo metadata only — no copyrighted media. Add licensed video URLs from the admin panel.
  const movies = [
    { slug: 'big-buck-bunny', title: 'Big Buck Bunny', year: 2008, minutes: 10, tier: 'FREE' as const, genres: ['animation', 'comedy'], overview: 'Open movie by the Blender Foundation (CC BY 3.0).' },
    { slug: 'sintel', title: 'Sintel', year: 2010, minutes: 15, tier: 'FREE' as const, genres: ['animation', 'drama'], overview: 'Open movie by the Blender Foundation (CC BY 3.0).' },
    { slug: 'tears-of-steel', title: 'Tears of Steel', year: 2012, minutes: 12, tier: 'PRO' as const, genres: ['sci-fi', 'action'], overview: 'Open movie by the Blender Foundation (CC BY 3.0).' },
  ];
  for (const m of movies) {
    await prisma.movie.upsert({
      where: { slug: m.slug },
      create: {
        slug: m.slug,
        title: m.title,
        overview: m.overview,
        releaseDate: new Date(`${m.year}-01-01`),
        releaseYear: m.year,
        durationMinutes: m.minutes,
        language: 'en',
        country: 'NL',
        accessTier: m.tier,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        genres: { create: m.genres.map((g) => ({ genreId: genreBySlug.get(g) as string })) },
      },
      update: {},
    });
  }
  console.log(`✔ ${genres.length} genres, ${movies.length} demo movies`);

  // Demo accounts. Password is documented in README. Protected so other admins cannot ban or delete them.
  const demoPassword = await hashPassword('DevPassword123');
  const demoUsers = [
    { email: 'admin@cinewave.local', displayName: 'Demo Admin', role: SYSTEM_ROLES.ADMIN },
    { email: 'moderator@cinewave.local', displayName: 'Demo Moderator', role: SYSTEM_ROLES.MODERATOR },
    { email: 'user@cinewave.local', displayName: 'Demo User', role: SYSTEM_ROLES.USER },
  ];
  const userRole = await prisma.role.findUniqueOrThrow({ where: { name: SYSTEM_ROLES.USER } });
  for (const u of demoUsers) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: u.role } });
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: { email: u.email, displayName: u.displayName, passwordHash: demoPassword, emailVerifiedAt: new Date(), isProtected: true },
      update: { passwordHash: demoPassword, status: 'ACTIVE', isProtected: true },
    });
    for (const roleId of new Set([userRole.id, role.id])) {
      await prisma.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId } }, create: { userId: user.id, roleId }, update: {} });
    }
  }
  console.log(`✔ demo users: ${demoUsers.map((u) => u.email).join(', ')} (password: DevPassword123)`);
}

// Executed directly: `node dist/cli/seed.js` (production image) — prisma/seed.ts reuses seed() in development.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  seed(prisma, process.env.NODE_ENV ?? 'development')
    .then(() => prisma.$disconnect())
    .catch(async (err: unknown) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
