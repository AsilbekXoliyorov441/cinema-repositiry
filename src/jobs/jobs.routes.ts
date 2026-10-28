import { z } from 'zod';
import { ApiRouter } from '../common/http/api-router.js';
import { PERMISSIONS } from '../common/constants/permissions.js';
import { AppError } from '../common/errors/app-error.js';
import { sendSuccess } from '../common/http/response.js';
import { getQueue, MAINTENANCE_JOBS, QUEUE_NAMES, type QueueName } from './queues.js';

const api = new ApiRouter('Admin · Jobs');
const queueName = z.enum(Object.values(QUEUE_NAMES) as [QueueName, ...QueueName[]]);

api
  .route({
    method: 'get',
    path: '/admin/jobs',
    summary: 'Queue counts',
    permissions: [PERMISSIONS.JOBS_MANAGE],
    response: z.array(z.object({ queue: z.string(), counts: z.record(z.string(), z.number()) })),
    handler: async ({ res }) => {
      const result = await Promise.all(
        Object.values(QUEUE_NAMES).map(async (q) => ({ queue: q, counts: await getQueue(q).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed') })),
      );
      sendSuccess(res, result);
    },
  })
  .route({
    method: 'get',
    path: '/admin/jobs/:queue/failed',
    summary: 'Failed jobs of a queue',
    description: 'Job payloads are never returned (email jobs contain one-time tokens).',
    permissions: [PERMISSIONS.JOBS_MANAGE],
    params: z.object({ queue: queueName }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
    response: z.array(z.object({ id: z.string(), name: z.string(), failedReason: z.string().nullable(), attemptsMade: z.number(), timestamp: z.number(), finishedOn: z.number().nullable() })),
    handler: async ({ res, params, query }) => {
      const jobs = await getQueue(params.queue).getFailed(0, query.limit - 1);
      sendSuccess(
        res,
        jobs.map((j) => ({ id: String(j.id), name: j.name, failedReason: j.failedReason ?? null, attemptsMade: j.attemptsMade, timestamp: j.timestamp, finishedOn: j.finishedOn ?? null })),
      );
    },
  })
  .route({
    method: 'post',
    path: '/admin/jobs/:queue/:jobId/retry',
    summary: 'Retry a failed job',
    permissions: [PERMISSIONS.JOBS_MANAGE],
    params: z.object({ queue: queueName, jobId: z.string().max(100) }),
    response: null,
    errors: [404, 409],
    handler: async ({ res, params }) => {
      const job = await getQueue(params.queue).getJob(params.jobId);
      if (!job) throw AppError.notFound('Job');
      if (!(await job.isFailed())) throw AppError.conflict('Only failed jobs can be retried');
      await job.retry();
      sendSuccess(res, null, { message: 'Job re-queued' });
    },
  })
  .route({
    method: 'post',
    path: '/admin/jobs/maintenance/:name/run',
    summary: 'Run a maintenance job now',
    permissions: [PERMISSIONS.JOBS_MANAGE],
    params: z.object({ name: z.enum(Object.values(MAINTENANCE_JOBS) as [string, ...string[]]) }),
    response: z.object({ jobId: z.string() }),
    handler: async ({ res, params }) => {
      const job = await getQueue(QUEUE_NAMES.MAINTENANCE).add(params.name, {}, { attempts: 1 });
      sendSuccess(res, { jobId: String(job.id) }, { message: 'Job queued' });
    },
  });

export const jobsRouter = api.router;
