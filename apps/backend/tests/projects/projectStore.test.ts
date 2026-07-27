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
    process.env.DATABASE_URL = '';

    expect(() => getProjectStore()).toThrow('DATABASE_URL is required for project storage.');
  });
});
