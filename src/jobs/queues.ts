import { Queue, type JobsOptions } from 'bullmq';
import { createBullConnection } from '../config/redis.js';
import { logger } from '../config/logger.js';
import type { EmailTemplate } from '../integrations/email/templates.js';

export const QUEUE_NAMES = {
  EMAIL: 'email',
  MAINTENANCE: 'maintenance',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const MAINTENANCE_JOBS = {
  EXPIRE_SUBSCRIPTIONS: 'expire-subscriptions',
  SUBSCRIPTION_REMINDERS: 'subscription-reminders',
  RECONCILE_PAYMENTS: 'reconcile-payments',
  RELEASE_COUPON_RESERVATIONS: 'release-coupon-reservations',
  ORPHAN_MEDIA: 'orphan-media',
  COMPUTE_STATS: 'compute-stats',
  CLEANUP_TOKENS: 'cleanup-tokens',
} as const;
export type MaintenanceJobName = (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS];

export type EmailJobData = { to: string } & EmailTemplate;

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  // Failed jobs are kept for inspection/retry through the admin API.
  removeOnFail: { age: 14 * 24 * 3600 },
};

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: createBullConnection(), defaultJobOptions });
    queues.set(name, queue);
  }
  return queue;
}

/**
 * Queues a transactional email. Never throws: if Redis is unavailable the failure is logged
 * (without the message content) and the user can request the email again.
 */
export async function enqueueEmail(job: EmailJobData): Promise<void> {
  try {
    await getQueue(QUEUE_NAMES.EMAIL).add(job.template, job);
  } catch (err) {
    logger.error({ err: (err as Error).message, template: job.template }, 'Failed to enqueue email');
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
