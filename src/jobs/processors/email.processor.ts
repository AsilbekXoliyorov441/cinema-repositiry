import type { Job } from 'bullmq';
import { emailProvider, renderEmail } from '../../integrations/email/index.js';
import type { EmailJobData } from '../queues.js';

export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { to, ...template } = job.data;
  const message = renderEmail(template);
  await emailProvider.send({ to, ...message });
}
