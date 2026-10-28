import { PrismaClient } from '@prisma/client';
import { isProduction } from './env.js';
import { logger } from './logger.js';

export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
  errorFormat: isProduction ? 'minimal' : 'colorless',
});

prisma.$on('warn', (e) => logger.warn({ target: e.target }, e.message));
prisma.$on('error', (e) => logger.error({ target: e.target }, e.message));

export type Db = typeof prisma;
/** Transaction client type, usable by repositories that run inside `prisma.$transaction`. */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type DbOrTx = Db | Tx;

export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
