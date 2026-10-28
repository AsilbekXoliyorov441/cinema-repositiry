import { env } from '../../config/env.js';
import type { EmailProvider } from './email.types.js';
import { FileEmailProvider } from './file.provider.js';
import { SmtpEmailProvider } from './smtp.provider.js';

function createEmailProvider(): EmailProvider {
  if (env.EMAIL_PROVIDER === 'smtp') {
    return new SmtpEmailProvider(env.EMAIL_FROM, {
      host: env.SMTP_HOST as string,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
    });
  }
  return new FileEmailProvider(env.EMAIL_FILE_DIR);
}

export const emailProvider = createEmailProvider();
export { renderEmail, type EmailTemplate } from './templates.js';
