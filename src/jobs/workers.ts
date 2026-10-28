import { Worker } from 'bullmq';
import { createBullConnection } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { getQueue, MAINTENANCE_JOBS, QUEUE_NAMES, type MaintenanceJobName } from './queues.js';
import { processEmailJob } from './processors/email.processor.js';
import { processMaintenanceJob } from './processors/maintenance.processor.js';

/** Recurring schedules (cron in UTC or fixed intervals). Upserted on every start, so they are never duplicated. */
const SCHEDULES: Record<MaintenanceJobName, { every?: number; pattern?: string }> = {
  [MAINTENANCE_JOBS.EXPIRE_SUBSCRIPTIONS]: { every: 10 * 60_000 },
  [MAINTENANCE_JOBS.RELEASE_COUPON_RESERVATIONS]: { every: 15 * 60_000 },
  [MAINTENANCE_JOBS.RECONCILE_PAYMENTS]: { pattern: '7 * * * *' },
  [MAINTENANCE_JOBS.COMPUTE_STATS]: { pattern: '*/30 * * * *' },
  [MAINTENANCE_JOBS.SUBSCRIPTION_REMINDERS]: { pattern: '0 9 * * *' },
  [MAINTENANCE_JOBS.ORPHAN_MEDIA]: { pattern: '30 3 * * *' },
  [MAINTENANCE_JOBS.CLEANUP_TOKENS]: { pattern: '0 4 * * *' },
};

export async function registerSchedules(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.MAINTENANCE);
  for (const [name, repeat] of Object.entries(SCHEDULES)) {
    await queue.upsertJobScheduler(`schedule:${name}`, repeat, { name, opts: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } } });
  }
}

export async function startWorkers(): Promise<{ close: () => Promise<void> }> {
  const workers = [
    new Worker(QUEUE_NAMES.EMAIL, processEmailJob, { connection: createBullConnection(), concurrency: 5 }),
    // Maintenance jobs touch many rows; run them one at a time per worker.
    new Worker(QUEUE_NAMES.MAINTENANCE, processMaintenanceJob, { connection: createBullConnection(), concurrency: 1 }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) =>
      // Only job metadata is logged — never job.data (emails contain one-time tokens).
      logger.error({ queue: w.name, jobId: job?.id, job: job?.name, attempts: job?.attemptsMade, err: err.message }, 'Job failed'),
    );
    w.on('error', (err) => logger.error({ queue: w.name, err: err.message }, 'Worker error'));
  }
  await registerSchedules();
  logger.info('Background workers started');
  return {
    close: async () => {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
