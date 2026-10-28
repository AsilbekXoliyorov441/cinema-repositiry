import { logger } from './config/logger.js';
import { connectDependencies, disconnectDependencies, registerShutdown } from './config/lifecycle.js';
import { closeQueues } from './jobs/queues.js';
import { startWorkers } from './jobs/workers.js';

/** Standalone worker process (recommended in production: scale API and workers independently). */
async function main(): Promise<void> {
  await connectDependencies();
  const workers = await startWorkers();
  registerShutdown([workers.close, closeQueues, disconnectDependencies]);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
