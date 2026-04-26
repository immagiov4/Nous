import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { HttpProjectRepository } from '../../../services/projects/httpProjectRepository.ts';
import {
  createProjectRepository,
  getProjectRepositoryMode,
} from '../../../services/projects/projectRepositoryFactory.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('getProjectRepositoryMode defaults to browser-local IndexedDB', () => {
  vi.stubEnv('VITE_PROJECT_REPOSITORY_MODE', '');

  assert.equal(getProjectRepositoryMode(), 'indexeddb');
});

test('createProjectRepository selects the LAN HTTP repository when configured', () => {
  vi.stubEnv('VITE_PROJECT_REPOSITORY_MODE', 'lan');

  assert.equal(getProjectRepositoryMode(), 'lan');
  assert.equal(createProjectRepository() instanceof HttpProjectRepository, true);
});
