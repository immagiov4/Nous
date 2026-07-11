import { HttpProjectRepository } from './httpProjectRepository';
import type { ProjectRepository } from './projectRepository';

export type ProjectRepositoryMode = 'server';

export const createProjectRepository = (): ProjectRepository => new HttpProjectRepository();
