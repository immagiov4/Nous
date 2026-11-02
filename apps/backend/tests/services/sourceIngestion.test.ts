import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  prepareSourceCollection,
  SourcePreparationUnusableError,
} from '../../src/projects/sourceIngestion.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test('prepares indexes from actual uploaded text and reports an unusable container member by name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nous-ingestion-test-'));
  directories.push(directory);
  const path = join(directory, 'sources');
  const bytes = Buffer.from('Course introduction\n\n# Natural numbers\n\n∀ n ∈ ℕ: n + 0 = n');
  const nested = Buffer.from('PK\x03\x04untrusted ZIP content');
  await writeFile(path, Buffer.concat([bytes, nested]));
  const files = [
    {
      id: 'source-note',
      name: 'notes/lesson.md',
      mimeType: 'text/markdown',
      byteSize: bytes.length,
    },
    { id: 'source-nested', name: 'archive.txt', mimeType: 'text/plain', byteSize: nested.length },
  ];
  const snapshot = {
    id: 'course',
    version: '4.1',
    createdAt: '',
    updatedAt: '',
    lastOpenedAt: '',
    source: {
      kind: 'document',
      file: { name: files[0].name, mimeType: 'text/plain', data: '' },
      sources: files.map((file, position) => ({
        ...file,
        file: { name: file.name, mimeType: file.mimeType, data: '', sourceId: file.id },
        position,
        status: 'ready',
        kind: file.name.endsWith('.md') ? 'markdown' : 'text',
        outline: [],
        outlineOrigin: 'none',
        hash: '0'.repeat(64),
      })),
    },
  };
  const progress: unknown[] = [];
  const result = await prepareSourceCollection({
    snapshot,
    upload: { path, files },
    context: {
      userId: 'learner',
      uploadId: 'upload',
      projectId: 'course',
      signal: new AbortController().signal,
      reportProgress: value => progress.push(value),
    },
  });
  expect(result.failures).toMatchObject([{ name: 'archive.txt' }]);
  expect(result.snapshot.documentIndex).toMatchObject({
    sourceIds: ['source-note'],
    chunks: [
      { sourceId: 'source-note', text: 'Course introduction', headingPath: ['notes/lesson.md'] },
      {
        sourceId: 'source-note',
        text: '# Natural numbers\n\n∀ n ∈ ℕ: n + 0 = n',
        headingPath: ['notes/lesson.md', 'Natural numbers'],
      },
    ],
  });
  expect(result.snapshot.source).toMatchObject({
    sources: [
      {
        id: 'source-note',
        status: 'ready',
        outline: [{ title: 'Natural numbers' }],
        outlineOrigin: 'deterministic',
      },
      { id: 'source-nested', status: 'error' },
    ],
  });
  expect(progress.at(-1)).toMatchObject({ step: 'extraction', completed: 2, total: 2 });
  expect(progress[0]).toMatchObject({
    documents: [
      { id: 'source-note', name: 'notes/lesson.md', state: 'reading' },
      { id: 'source-nested', name: 'archive.txt', state: 'idle' },
    ],
  });
  expect(progress.at(-1)).toMatchObject({
    documents: [
      { id: 'source-note', state: 'done' },
      { id: 'source-nested', state: 'error' },
    ],
  });
});

test.each([
  { bytes: Buffer.from('   '), reason: 'no-usable-text' },
  { bytes: Buffer.from([255, 0]), reason: 'parser-failed' },
])('returns named reasons when every file is unusable ($reason)', async ({ bytes, reason }) => {
  const directory = await mkdtemp(join(tmpdir(), 'nous-ingestion-test-'));
  directories.push(directory);
  const path = join(directory, 'source');
  await writeFile(path, bytes);
  const file = {
    id: 'source-blank',
    name: 'blank.txt',
    mimeType: 'text/plain',
    byteSize: bytes.length,
  };
  const snapshot = {
    id: 'blank-course',
    version: '4.1',
    createdAt: '',
    updatedAt: '',
    lastOpenedAt: '',
    source: {
      kind: 'document',
      file: { name: file.name, mimeType: file.mimeType, data: '' },
      sources: [
        {
          id: file.id,
          name: file.name,
          hash: '0'.repeat(64),
          kind: 'text',
          status: 'ready',
          position: 0,
          outline: [],
          outlineOrigin: 'none',
          file: { name: file.name, mimeType: file.mimeType, data: '' },
        },
      ],
    },
  };
  const preparing = prepareSourceCollection({
    snapshot,
    upload: { path, files: [file] },
    context: {
      userId: 'learner',
      uploadId: 'upload',
      projectId: snapshot.id,
      signal: new AbortController().signal,
      reportProgress: () => undefined,
    },
  });
  await expect(preparing).rejects.toBeInstanceOf(SourcePreparationUnusableError);
  await expect(preparing).rejects.toMatchObject({
    failures: [{ name: 'blank.txt', reason }],
    documents: [{ id: 'source-blank', name: 'blank.txt', state: 'error' }],
  });
});

test.each([
  'source-new',
  'source-replaced',
])('retains unopened source text while preparing %s', async uploadedId => {
  const directory = await mkdtemp(join(tmpdir(), 'nous-retained-source-'));
  directories.push(directory);
  const path = join(directory, 'source');
  const bytes = Buffer.from('New uploaded text');
  await writeFile(path, bytes);
  const descriptor = (id: string, text: string) => ({
    id,
    name: `${id}.txt`,
    hash: id,
    kind: 'text',
    status: 'ready',
    position: 0,
    outline: [],
    outlineOrigin: 'none',
    file: { name: `${id}.txt`, mimeType: 'text/plain', data: '' },
    documentIndex: {
      kind: 'pdf-text-index',
      parsedAt: '2026-10-21',
      chunks: [
        {
          id: `${id}-chunk`,
          text,
          headingPath: [],
          sequence: 0,
          startOffset: 0,
          endOffset: text.length,
          sourceId: id,
        },
      ],
    },
  });
  const retained = descriptor('source-retained', 'Retained complete text');
  const replaced = descriptor('source-replaced', 'Replaced old text');
  const stored = {
    id: 'course',
    version: '4.1',
    createdAt: '',
    updatedAt: '',
    lastOpenedAt: '',
    source: { kind: 'document', sources: [retained, replaced] },
  };
  const deferred = {
    ...retained,
    documentIndex: {
      ...retained.documentIndex,
      textDeferred: true,
      chunks: retained.documentIndex.chunks.map(chunk => ({ ...chunk, text: '' })),
    },
  };
  const uploaded = descriptor(uploadedId, 'Untrusted client text');
  const result = await prepareSourceCollection({
    snapshot: { ...stored, source: { kind: 'document', sources: [deferred, uploaded] } },
    storedSnapshot: stored,
    upload: {
      path,
      files: [
        { id: uploadedId, name: uploaded.name, mimeType: 'text/plain', byteSize: bytes.length },
      ],
    },
    context: {
      userId: 'learner',
      projectId: 'course',
      uploadId: 'upload',
      signal: new AbortController().signal,
      reportProgress: () => undefined,
    },
  });
  const combined = result.snapshot.documentIndex as { chunks: { text: string }[] };
  expect(combined.chunks.map(chunk => chunk.text)).toEqual([
    'Retained complete text',
    'New uploaded text',
  ]);
  expect(result.snapshot.source).toMatchObject({
    sources: [
      { documentIndex: retained.documentIndex },
      { documentIndex: { chunks: [{ text: 'New uploaded text' }] } },
    ],
  });
});
