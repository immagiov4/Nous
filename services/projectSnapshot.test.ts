import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createProjectSourceFromFile,
  decodeTextBase64,
  encodeTextBase64,
  getProjectSourceFile,
} from './projectSource.ts';
import { buildCoverLabel, inferProjectSourceKind } from './projectSnapshot.ts';

test('createProjectSourceFromFile upgrades legacy zip payloads into structured codebase sources', () => {
  const source = createProjectSourceFromFile({
    name: 'repo.zip',
    mimeType: 'text/plain',
    data: encodeTextBase64('--- START OF FILE: src/index.ts ---\nconsole.log("hi");'),
  });

  assert.equal(source.kind, 'codebase-bundle');
  assert.match(source.aggregatedText, /src\/index\.ts/);
});

test('getProjectSourceFile preserves a round-trip legacy file payload for codebase bundles', () => {
  const source = createProjectSourceFromFile({
    name: 'repo.zip',
    mimeType: 'text/plain',
    data: encodeTextBase64('console.log("hi");'),
  });

  const file = getProjectSourceFile(source);

  assert.equal(file?.name, 'repo.zip');
  assert.equal(file?.mimeType, 'text/plain');
  assert.equal(decodeTextBase64(file?.data || ''), 'console.log("hi");');
});

test('inferProjectSourceKind treats single text files as documents', () => {
  const source = createProjectSourceFromFile({
    name: 'notes.md',
    mimeType: 'text/markdown',
    data: encodeTextBase64('# Notes'),
  });

  assert.equal(inferProjectSourceKind({ source, isLearnMode: false }), 'document');
  assert.equal(
    buildCoverLabel({ source, learningPlan: null, isLearnMode: false }, 'document'),
    'notes.md'
  );
});

test('inferProjectSourceKind keeps zip-backed codebase bundles as codebase projects', () => {
  const source = createProjectSourceFromFile({
    name: 'repo.zip',
    mimeType: 'text/plain',
    data: encodeTextBase64('console.log("hi");'),
  });

  assert.equal(inferProjectSourceKind({ source, isLearnMode: false }), 'codebase');
});
