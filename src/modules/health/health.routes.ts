import { Router } from 'express';
import { checkDatabase } from '../../config/database.js';
import { checkRedis } from '../../config/redis.js';

/** Liveness/readiness probes, mounted outside the API prefix (used by Docker/Kubernetes). */
export const healthRouter = Router();

healthRouter.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

healthRouter.get('/health/ready', async (_req, res) => {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const ok = database && redis;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks: { database, redis } });
});
