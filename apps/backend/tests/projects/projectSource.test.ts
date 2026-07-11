import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachProjectSource, detachProjectSource } from '../../src/projects/projectSource.js';
import type { ProjectSnapshot, ProjectSourceRef } from '../../src/projects/types.js';

test('backend source storage detaches and hydrates only the primary file in a source set', () => {
  const snapshot: ProjectSnapshot = {
    id: 'project-multi',
    version: '4.1',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    lastOpenedAt: '2026-07-11T00:00:00.000Z',
    source: {
      kind: 'pdf',
      file: {
        name: 'primary.pdf',
        mimeType: 'application/pdf',
        data: 'primary-bytes',
        sourceId: 'source-primary',
      },
      sources: [
        {
          id: 'source-primary',
          file: {
            name: 'primary.pdf',
            mimeType: 'application/pdf',
            data: 'primary-bytes',
            sourceId: 'source-primary',
          },
        },
        {
          id: 'source-secondary',
          file: {
            name: 'secondary.txt',
            mimeType: 'text/plain',
            data: 'secondary-bytes',
            sourceId: 'source-secondary',
          },
        },
      ],
    },
  };
  const ref: ProjectSourceRef = {
    id: 'stored-source',
    hash: 'hash',
    byteSize: 13,
    name: 'primary.pdf',
    mimeType: 'application/pdf',
  };

  const detached = detachProjectSource(snapshot, ref);
  const detachedSource = detached.source as {
    file: { data: string };
    sources: Array<{ file: { data: string } }>;
  };
  assert.equal(detachedSource.file.data, '');
  assert.equal(detachedSource.sources[0]?.file.data, '');
  assert.equal(detachedSource.sources[1]?.file.data, 'secondary-bytes');

  const hydrated = attachProjectSource(detached, {
    name: 'primary.pdf',
    mimeType: 'application/pdf',
    data: 'restored-primary',
  });
  const hydratedSource = hydrated.source as {
    file: { data: string; sourceId?: string };
    sources: Array<{ file: { data: string } }>;
  };
  assert.equal(hydratedSource.file.data, 'restored-primary');
  assert.equal(hydratedSource.file.sourceId, 'source-primary');
  assert.equal(hydratedSource.sources[0]?.file.data, 'restored-primary');
  assert.equal(hydratedSource.sources[1]?.file.data, 'secondary-bytes');
});
