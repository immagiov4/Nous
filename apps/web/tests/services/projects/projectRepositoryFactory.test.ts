// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { HttpProjectRepository } from '../../../services/projects/httpProjectRepository.ts';
import {
  createProjectRepository,
  getProjectRepositoryMode,
  setProjectRepositoryMode,
} from '../../../services/projects/projectRepositoryFactory.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

test('getProjectRepositoryMode is always server-backed', () => {
  vi.stubEnv('VITE_PROJECT_REPOSITORY_MODE', '');

  assert.equal(getProjectRepositoryMode(), 'server');
});

test('createProjectRepository always selects the server HTTP repository', () => {
  vi.stubEnv('VITE_PROJECT_REPOSITORY_MODE', 'indexeddb');

  assert.equal(getProjectRepositoryMode(), 'server');
  assert.equal(createProjectRepository() instanceof HttpProjectRepository, true);
});

test('setProjectRepositoryMode clears legacy local mode state', () => {
  window.localStorage.setItem('projectRepositoryMode', 'indexeddb');

  setProjectRepositoryMode('server');
  assert.equal(getProjectRepositoryMode(), 'server');
  assert.equal(window.localStorage.getItem('projectRepositoryMode'), null);
});
