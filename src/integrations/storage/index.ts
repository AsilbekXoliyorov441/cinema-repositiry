import { env } from '../../config/env.js';
import { LocalStorageService } from './local-storage.service.js';
import type { StorageService } from './storage.types.js';

export const publicMediaBaseUrl = (env.PUBLIC_MEDIA_BASE_URL ?? `${env.APP_URL}/media`).replace(/\/$/, '');

function createStorage(): LocalStorageService {
  switch (env.STORAGE_DRIVER) {
    case 'local':
      return new LocalStorageService(env.LOCAL_STORAGE_PATH, publicMediaBaseUrl);
  }
}

/** The configured storage backend. Add an S3 adapter implementing StorageService to switch drivers. */
export const localStorage = createStorage();
export const storage: StorageService = localStorage;
export type { StorageService };
