import { HttpProjectRepository } from './httpProjectRepository';
import { IndexedDbProjectRepository } from './indexedDbProjectRepository';
import type { ProjectRepository } from './projectRepository';

export type ProjectRepositoryMode = 'indexeddb' | 'lan';

const PROJECT_REPOSITORY_MODE_STORAGE_KEY = 'projectRepositoryMode';

const normalizeRepositoryMode = (value: unknown): ProjectRepositoryMode => {
  return value === 'lan' ? 'lan' : 'indexeddb';
};

export const getProjectRepositoryMode = (): ProjectRepositoryMode => {
  if (typeof window !== 'undefined') {
    const storedMode = window.localStorage.getItem(PROJECT_REPOSITORY_MODE_STORAGE_KEY);
    if (storedMode === 'lan' || storedMode === 'indexeddb') {
      return storedMode;
    }
  }

  const viteMode =
    typeof import.meta !== 'undefined' ? import.meta.env.VITE_PROJECT_REPOSITORY_MODE : undefined;
  const processMode =
    typeof process !== 'undefined' ? process.env.PROJECT_REPOSITORY_MODE : undefined;

  return normalizeRepositoryMode(viteMode || processMode);
};

export const setProjectRepositoryMode = (mode: ProjectRepositoryMode): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(PROJECT_REPOSITORY_MODE_STORAGE_KEY, mode);
};

export const createProjectRepository = (
  mode: ProjectRepositoryMode = getProjectRepositoryMode()
): ProjectRepository => {
  if (mode === 'lan') {
    return new HttpProjectRepository();
  }

  return new IndexedDbProjectRepository();
};
