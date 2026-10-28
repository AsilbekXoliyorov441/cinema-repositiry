import { PrismaClient } from '@prisma/client';
import { seed } from '../src/cli/seed.js';

const prisma = new PrismaClient();

seed(prisma, process.env.NODE_ENV ?? 'development')
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
