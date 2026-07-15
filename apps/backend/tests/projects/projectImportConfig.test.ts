import { expect, test } from 'vitest';

import { readProjectImportConfig } from '../../src/projects/projectImportConfig.js';

test('project import limits use coherent machine defaults', () => {
  const config = readProjectImportConfig({});

  expect(config.activeUploadsGlobal).toBe(2);
  expect(config.maxChunkBytes * config.maxChunkCount).toBeGreaterThanOrEqual(
    config.maxSerializedBytes
  );
  expect(config.cleanupIntervalMs).toBeLessThanOrEqual(config.receivingUploadTtlMs);
});

test('project import limits accept deployment overrides and reject incoherent capacity', () => {
  expect(
    readProjectImportConfig({
      PROJECT_IMPORT_ACTIVE_UPLOADS_GLOBAL: '4',
      PROJECT_IMPORT_ACTIVE_UPLOADS_PER_USER: '2',
    }).activeUploadsPerUser
  ).toBe(2);

  expect(() =>
    readProjectImportConfig({
      PROJECT_IMPORT_ACTIVE_UPLOADS_GLOBAL: '1',
      PROJECT_IMPORT_ACTIVE_UPLOADS_PER_USER: '2',
    })
  ).toThrow(/cannot exceed/iu);
});
