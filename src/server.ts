import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDependencies, disconnectDependencies, registerShutdown } from './config/lifecycle.js';
import { createApp } from './app.js';
import { closeQueues } from './jobs/queues.js';
import { startWorkers } from './jobs/workers.js';

async function main(): Promise<void> {
  await connectDependencies();

  const app = createApp();
  const server = createServer(app);
  server.keepAliveTimeout = 65_000; // longer than typical load balancer idle timeouts
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;

  const workers = env.RUN_WORKERS_IN_API ? await startWorkers() : undefined;

  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, docs: env.SWAGGER_ENABLED ? `${env.APP_URL}/docs` : 'disabled', workers: Boolean(workers) },
      'CineWave API listening',
    );
  });

  registerShutdown([
    () => new Promise<void>((resolve) => server.close(() => resolve())),
    async () => workers?.close(),
    closeQueues,
    disconnectDependencies,
  ]);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
