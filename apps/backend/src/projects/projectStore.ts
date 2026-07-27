import { PostgresProjectStore } from './postgresProjectStore.js';
import type { ProjectStore } from './types.js';

let projectStore: ProjectStore | null = null;

export const getProjectStore = (): ProjectStore => {
  if (!projectStore) {
    projectStore = new PostgresProjectStore();
  }

  return projectStore;
};

export const setProjectStoreForTesting = (store: ProjectStore | null): void => {
  projectStore = store;
};
