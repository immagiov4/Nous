import { SqliteProjectStore } from './sqliteProjectStore.js';
import type { ProjectStore } from './types.js';

let projectStore: ProjectStore | null = null;

export const getProjectStore = (): ProjectStore => {
  if (!projectStore) {
    const driver = process.env.PROJECT_STORAGE_DRIVER || 'sqlite';
    if (driver !== 'sqlite') {
      throw new Error(`Unsupported project storage driver: ${driver}`);
    }

    projectStore = new SqliteProjectStore();
  }

  return projectStore;
};

export const setProjectStoreForTesting = (store: ProjectStore | null): void => {
  projectStore = store;
};
