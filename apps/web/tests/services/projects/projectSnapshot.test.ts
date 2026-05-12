import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildCoverLabel,
  exportProjectData,
  inferProjectSourceKind,
  normalizeImportedProject,
} from '../../../services/projects/projectSnapshot.ts';
import {
  createProjectSourceFromFile,
  decodeTextBase64,
  encodeTextBase64,
  getProjectSourceFile,
} from '../../../services/projects/projectSource.ts';
import { AppState, type ProjectSnapshot } from '../../../types.ts';

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

test('exportProjectData keeps the source only once for modern exports', () => {
  const pdfFile = {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    data: encodeTextBase64('fake-pdf-binary'),
  };
  const snapshot: ProjectSnapshot = {
    id: 'project-1',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: {
      kind: 'pdf',
      file: pdfFile,
    },
    learningPlan: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    createdAt: '2026-04-03T00:00:00.000Z',
    updatedAt: '2026-04-03T00:00:00.000Z',
    lastOpenedAt: '2026-04-03T00:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const exported = exportProjectData(snapshot);

  assert.deepEqual(exported.source, snapshot.source);
  assert.equal(Object.hasOwn(exported, 'file'), false);
});

test('normalizeImportedProject still supports legacy file-only exports', () => {
  const pdfFile = {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    data: encodeTextBase64('fake-pdf-binary'),
  };

  const imported = normalizeImportedProject({
    version: '3.0',
    file: pdfFile,
    learningPlan: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
  });

  assert.deepEqual(imported.source, {
    kind: 'pdf',
    file: pdfFile,
  });
});
