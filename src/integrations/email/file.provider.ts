import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EmailMessage, EmailProvider } from './email.types.js';

/**
 * Development-only provider: writes each email as an .html file you can open in a browser.
 * Nothing is printed to logs, so tokens never leak into log aggregation.
 */
export class FileEmailProvider implements EmailProvider {
  readonly name = 'file';
  constructor(private readonly dir: string) {}

  async send(message: EmailMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const safeTo = message.to.replace(/[^a-z0-9@._-]/gi, '_');
    const file = path.join(this.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeTo}_${randomUUID().slice(0, 8)}.html`);
    const header = `<!-- To: ${safeTo} | Subject: ${message.subject.replace(/-->/g, '')} -->\n`;
    await writeFile(file, header + message.html, { mode: 0o600 });
  }
}
