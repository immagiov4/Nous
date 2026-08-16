import { describe, expect, test } from 'vitest';

import { createAnonymousScannerEnvironment } from './run-sonar-scan.ts';

describe('createAnonymousScannerEnvironment', () => {
  test('removes an inherited Sonar token without changing other environment values', () => {
    expect(
      createAnonymousScannerEnvironment({
        PATH: 'test-path',
        SONAR_TOKEN: 'other-sonar-token',
      })
    ).toEqual({ PATH: 'test-path' });
  });
});
