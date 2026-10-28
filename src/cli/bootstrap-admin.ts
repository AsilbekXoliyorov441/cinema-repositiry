import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { SYSTEM_ROLES } from '../common/constants/permissions.js';
import { hashPassword, passwordSchema } from '../modules/auth/password.service.js';

/**
 * One-time creation of the first SUPER_ADMIN.
 *
 *  - Refuses to run if any SUPER_ADMIN already exists (cannot be re-used to take over an instance).
 *  - Credentials come from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD or an interactive prompt.
 *  - Password policy is enforced; there is no default password.
 *  - The account is flagged `isProtected` and the action is written to the audit log.
 *
 * Usage: npm run bootstrap:admin   (production image: npm run bootstrap:admin:prod)
 */
const prisma = new PrismaClient();

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const role = await prisma.role.findUnique({ where: { name: SYSTEM_ROLES.SUPER_ADMIN } });
  if (!role) throw new Error('Roles are not seeded. Run `npm run db:seed` (or db:seed:prod) first.');

  const existing = await prisma.userRole.count({ where: { roleId: role.id } });
  if (existing > 0) {
    console.error('✖ A SUPER_ADMIN already exists. Bootstrap is disabled; manage admins from the admin panel.');
    process.exit(1);
  }

  const email = z.email().parse((process.env.BOOTSTRAP_ADMIN_EMAIL ?? (await prompt('Super admin email: '))).toLowerCase());
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? (await prompt('Password (min 8 chars, letters + digits; input is visible — prefer the env var in CI): '));
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));

  const userRole = await prisma.role.findUniqueOrThrow({ where: { name: SYSTEM_ROLES.USER } });
  const passwordHash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    const found = await tx.user.findUnique({ where: { email } });
    const u = found
      ? await tx.user.update({ where: { id: found.id }, data: { passwordHash, isProtected: true, status: 'ACTIVE', emailVerifiedAt: found.emailVerifiedAt ?? new Date() } })
      : await tx.user.create({ data: { email, displayName: 'Super Admin', passwordHash, isProtected: true, emailVerifiedAt: new Date() } });
    for (const roleId of [userRole.id, role.id]) {
      await tx.userRole.upsert({ where: { userId_roleId: { userId: u.id, roleId } }, create: { userId: u.id, roleId }, update: {} });
    }
    await tx.auditLog.create({
      data: { actorId: null, action: 'bootstrap.super_admin_created', entityType: 'user', entityId: u.id, severity: 'HIGH', metadata: { email } },
    });
    return u;
  });

  console.log(`✔ Super admin ready: ${user.email}`);
  console.log('  Remove BOOTSTRAP_ADMIN_PASSWORD from the environment now, and enable MFA after the first login.');
}

main()
  .catch((err: unknown) => {
    console.error(`✖ ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
