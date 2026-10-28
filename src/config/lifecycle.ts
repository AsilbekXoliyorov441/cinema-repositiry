import { prisma } from './database.js';
import { redis } from './redis.js';
import { logger } from './logger.js';

async function waitFor(name: string, check: () => Promise<unknown>, attempts = 20, delayMs = 1500): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await check();
      logger.info(`${name} connected`);
      return;
    } catch (err) {
      logger.warn({ attempt: i, err: (err as Error).message }, `${name} not ready yet`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`${name} unavailable after ${attempts} attempts`);
}

/** Verifies PostgreSQL and Redis before accepting traffic. */
export async function connectDependencies(): Promise<void> {
  await waitFor('PostgreSQL', () => prisma.$queryRaw`SELECT 1`);
  await waitFor('Redis', async () => {
    if ((await redis.ping()) !== 'PONG') throw new Error('unexpected PING reply');
  });
}

export async function disconnectDependencies(): Promise<void> {
  await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
}

type ShutdownHook = () => Promise<void>;

/** Registers SIGTERM/SIGINT handlers that run hooks in order, with a hard timeout. */
export function registerShutdown(hooks: ShutdownHook[], timeoutMs = 20_000): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    const timer = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    for (const hook of hooks) {
      try {
        await hook();
      } catch (err) {
        logger.error({ err }, 'Shutdown hook failed');
      }
    }
    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });
}
