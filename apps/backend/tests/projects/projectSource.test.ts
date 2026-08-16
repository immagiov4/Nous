import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import {
  attachProjectSources,
  buildProjectSourceEntryObjectPath,
  detachProjectSources,
  readEmbeddedProjectSources,
} from '../../src/projects/projectSource.js';
import type { ProjectSnapshot, ProjectSourceRef } from '../../src/projects/types.js';

test('backend source storage detaches and hydrates every file in a source set', () => {
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
  const refs: ProjectSourceRef[] = ['primary', 'secondary'].map(name => ({
    id: `source-${name}`,
    hash: name.repeat(64).slice(0, 64),
    byteSize: 13,
    name: `${name}.${name === 'primary' ? 'pdf' : 'txt'}`,
    mimeType: name === 'primary' ? 'application/pdf' : 'text/plain',
    objectPath: `users/user/projects/project/source-${name}/original`,
  }));

  assert.deepEqual(
    readEmbeddedProjectSources(snapshot).map(source => source.id),
    ['source-primary', 'source-secondary']
  );

  const detached = detachProjectSources(snapshot, refs);
  const detachedSource = detached.source as {
    file: { data: string };
    sources: Array<{ file: { data: string }; ref: ProjectSourceRef }>;
  };
  assert.equal(detachedSource.file.data, '');
  assert.equal(detachedSource.sources[0]?.file.data, '');
  assert.equal(detachedSource.sources[1]?.file.data, '');
  assert.deepEqual(
    detachedSource.sources.map(source => source.ref.id),
    ['source-primary', 'source-secondary']
  );

  const hydrated = attachProjectSources(detached, [
    {
      file: {
        name: 'primary.pdf',
        mimeType: 'application/pdf',
        data: 'restored-primary',
      },
      ref: refs[0],
    },
    {
      file: {
        name: 'secondary.txt',
        mimeType: 'text/plain',
        data: 'restored-secondary',
      },
      ref: refs[1],
    },
  ]);
  const hydratedSource = hydrated.source as {
    file: { data: string; sourceId?: string };
    sources: Array<{ file: { data: string } }>;
  };
  assert.equal(hydratedSource.file.data, 'restored-primary');
  assert.equal(hydratedSource.file.sourceId, 'source-primary');
  assert.equal(hydratedSource.sources[0]?.file.data, 'restored-primary');
  assert.equal(hydratedSource.sources[1]?.file.data, 'restored-secondary');
});

test('archive entry object paths include canonical content identity', () => {
  const originalHash = 'a'.repeat(64);
  const extractedHash = 'b'.repeat(64);
  const commonArguments = [
    'user-1',
    'project-1',
    'source-1',
    originalHash,
    'docs/guide.pdf',
  ] as const;

  const originalPath = buildProjectSourceEntryObjectPath(...commonArguments, originalHash);
  const extractedPath = buildProjectSourceEntryObjectPath(...commonArguments, extractedHash);

  expect(originalPath).not.toBe(extractedPath);
  expect(extractedPath.endsWith(`/${extractedHash}`)).toBe(true);
});
