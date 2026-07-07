// Project store abstraction used by the backend routing layer.
import { PostgresProjectStore } from './postgresProjectStore.js';
import { SqliteProjectStore } from './sqliteProjectStore.js';
import type { ProjectStore } from './types.js';

let projectStore: ProjectStore | null = null;

export const getProjectStore = (): ProjectStore => {
  if (!projectStore) {
    const driver = process.env.PROJECT_STORAGE_DRIVER || 'postgres';
    if (driver === 'postgres') {
      projectStore = new PostgresProjectStore();
      return projectStore;
    }

    if (driver !== 'sqlite') {
      throw new Error(`Unsupported project storage driver: ${driver}`);
    }
    if (process.env.NODE_ENV !== 'test' && process.env.LOCAL_DEV_PROFILE !== 'true') {
      throw new Error(
        'PROJECT_STORAGE_DRIVER=sqlite is only allowed in test or local dev profile.'
      );
    }

    projectStore = new SqliteProjectStore();
  }

  return projectStore;
};

export const setProjectStoreForTesting = (store: ProjectStore | null): void => {
  projectStore = store;
};
