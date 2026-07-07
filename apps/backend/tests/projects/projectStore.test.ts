import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getProjectStore, setProjectStoreForTesting } from '../../src/projects/projectStore.js';

const ORIGINAL_ENV = { ...process.env };

describe('getProjectStore', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    setProjectStoreForTesting(null);
  });

  afterEach(() => {
    setProjectStoreForTesting(null);
    process.env = { ...ORIGINAL_ENV };
  });

  test('defaults to the Postgres server store', () => {
    process.env.PROJECT_STORAGE_DRIVER = '';
    process.env.DATABASE_URL = '';

    expect(() => getProjectStore()).toThrow(
      'DATABASE_URL is required when PROJECT_STORAGE_DRIVER=postgres.'
    );
  });

  test('blocks the SQLite driver outside test or explicit local dev profile', () => {
    process.env.PROJECT_STORAGE_DRIVER = 'sqlite';
    process.env.NODE_ENV = 'production';
    process.env.LOCAL_DEV_PROFILE = '';

    expect(() => getProjectStore()).toThrow(
      'PROJECT_STORAGE_DRIVER=sqlite is only allowed in test or local dev profile.'
    );
  });
});
