import { HttpProjectRepository } from './httpProjectRepository';
import type { ProjectRepository } from './projectRepository';

export type ProjectRepositoryMode = 'server';

const PROJECT_REPOSITORY_MODE_STORAGE_KEY = 'projectRepositoryMode';

export const getProjectRepositoryMode = (): ProjectRepositoryMode => 'server';

export const setProjectRepositoryMode = (_mode: ProjectRepositoryMode): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(PROJECT_REPOSITORY_MODE_STORAGE_KEY);
};

export const createProjectRepository = (
  _mode: ProjectRepositoryMode = getProjectRepositoryMode()
): ProjectRepository => {
  return new HttpProjectRepository();
};
