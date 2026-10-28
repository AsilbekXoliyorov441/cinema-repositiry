import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

/** Applies migrations to the test database once before the integration suite. */
export default function setup() {
  const env = parse(readFileSync(new URL('../../.env.test', import.meta.url)));
  if (!env.DATABASE_URL?.includes('_test')) throw new Error('Refusing to run integration tests: DATABASE_URL must point to a *_test database');
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, ...env } });
  return () => {
    rmSync(env.LOCAL_STORAGE_PATH ?? './storage/test-uploads', { recursive: true, force: true });
    rmSync(env.EMAIL_FILE_DIR ?? './storage/test-mail', { recursive: true, force: true });
  };
}
