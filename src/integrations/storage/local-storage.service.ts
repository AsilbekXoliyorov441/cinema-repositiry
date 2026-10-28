import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { StorageService } from './storage.types.js';

const KEY_PATTERN = /^(public|private)\/[a-z0-9][a-z0-9/_.-]*$/;

export class LocalStorageService implements StorageService {
  readonly driver = 'LOCAL' as const;
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly publicBaseUrl: string,
  ) {
    this.root = path.resolve(rootDir);
  }

  /** Resolves a key to an absolute path and guarantees it stays inside the storage root. */
  private resolve(key: string): string {
    if (!KEY_PATTERN.test(key) || key.includes('..') || key.includes('//')) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Storage key escapes root');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Write to a temp file first and rename, so readers never see partial files.
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, data, { mode: 0o640 });
    await rename(tmp, target);
  }

  async getStream(key: string): Promise<Readable> {
    const target = this.resolve(key);
    await stat(target);
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  publicUrl(key: string): string | undefined {
    if (!key.startsWith('public/')) return undefined;
    return `${this.publicBaseUrl}/${key.slice('public/'.length)}`;
  }

  async *listObjects(): AsyncIterable<{ key: string; lastModified: Date }> {
    const walk = async function* (dir: string, root: string): AsyncIterable<{ key: string; lastModified: Date }> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full, root);
        else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
          const info = await stat(full).catch(() => null);
          if (info) yield { key: path.relative(root, full).split(path.sep).join('/'), lastModified: info.mtime };
        }
      }
    };
    yield* walk(this.root, this.root);
  }

  /** Directory served statically for public media. */
  get publicDir(): string {
    return path.join(this.root, 'public');
  }
}
