import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
} from '../../../services/projects/courseSources.ts';
import type { LessonNode, PdfTextIndex, ProjectSource } from '../../../types.ts';
import {
  buildContextSourceMaterial,
  getLessonSourcePageLabel,
  resolveLessonSourceReferences,
} from '../../../utils/context/sourceMaterial.ts';

test('returns the complete archive index in deterministic path order without concatenated content', () => {
  const source: ProjectSource = {
    file: {
      data: 'UEs=',
      mimeType: 'application/zip',
      name: 'engine.zip',
    },
    index: {
      entries: [
        {
          byteSize: 2048,
          contentKind: 'binary',
          kind: 'file',
          path: 'textures/logo.png',
        },
        { kind: 'directory', path: 'docs' },
        {
          byteSize: 32,
          contentKind: 'text',
          hash: 'readme-hash',
          kind: 'file',
          path: 'docs/README.md',
          preview: '# Engine\nArchitecture',
        },
      ],
    },
    kind: 'archive',
    name: 'engine.zip',
  };

  const result = buildContextSourceMaterial({
    activeSection: null,
    documentIndex: null,
    source,
  });

  assert.equal(result.sourceKind, 'archive');
  assert.equal(result.sourceName, 'engine.zip');
  assert.equal(
    result.sourceMaterial,
    [
      'directory docs',
      'file docs/README.md | text | 32 bytes | sha256 readme-hash',
      'preview:',
      '# Engine',
      'Architecture',
      'file textures/logo.png | binary | 2048 bytes',
    ].join('\n')
  );
});

test('returns lesson-relevant pdf chunks when document index is available', () => {
  const source: ProjectSource = {
    kind: 'pdf',
    file: {
      name: 'dispensa.pdf',
      mimeType: 'application/pdf',
      data: 'ZmFrZQ==',
    },
  };
  const activeSection: LessonNode = {
    id: 'lesson-1',
    kind: 'lesson',
    title: 'Lezione 1',
    description: 'Intro',
    isCompleted: false,
    type: 'core',
    primaryChunkIds: ['chunk-002'],
  };
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-03-24T10:00:00.000Z',
    chunks: [
      {
        id: 'chunk-001',
        text: 'Contesto prima',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 14,
      },
      {
        id: 'chunk-002',
        text: 'Contesto principale',
        headingPath: ['Intro', 'Dettaglio'],
        sequence: 1,
        startOffset: 15,
        endOffset: 34,
      },
    ],
  };

  const result = buildContextSourceMaterial({
    activeSection,
    documentIndex,
    source,
  });

  assert.equal(result.sourceKind, 'pdf');
  assert.equal(result.sourceName, 'dispensa.pdf');
  assert.match(result.sourceMaterial ?? '', /CHUNK chunk-002/);
  assert.match(result.sourceMaterial ?? '', /Contesto principale/);
});

test('getLessonSourcePageLabel uses the primary lesson chunks page span', () => {
  const activeSection: LessonNode = {
    id: 'lesson-1',
    kind: 'lesson',
    title: 'Lezione 1',
    description: 'Intro',
    isCompleted: false,
    type: 'core',
    primaryChunkIds: ['chunk-002', 'chunk-003'],
  };
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-03-24T10:00:00.000Z',
    pageCount: 30,
    chunks: [
      {
        id: 'chunk-001',
        text: 'Contesto prima',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 14,
        pageStart: 2,
        pageEnd: 2,
      },
      {
        id: 'chunk-002',
        text: 'Contesto principale',
        headingPath: ['Intro', 'Dettaglio'],
        sequence: 1,
        startOffset: 15,
        endOffset: 34,
        pageStart: 10,
        pageEnd: 11,
      },
      {
        id: 'chunk-003',
        text: 'Approfondimento',
        headingPath: ['Intro', 'Dettaglio'],
        sequence: 2,
        startOffset: 35,
        endOffset: 55,
        pageStart: 12,
        pageEnd: 12,
      },
    ],
  };

  assert.equal(
    getLessonSourcePageLabel({
      activeSection,
      documentIndex,
    }),
    'pag. 10-12'
  );
});

test('getLessonSourcePageLabel keeps discontinuous source ranges visible', () => {
  const activeSection: LessonNode = {
    id: 'lesson-1',
    kind: 'lesson',
    title: 'Lezione 1',
    description: 'Intro',
    isCompleted: false,
    type: 'core',
    primaryChunkIds: ['chunk-002', 'chunk-003'],
  };
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-03-24T10:00:00.000Z',
    pageCount: 30,
    chunks: [
      {
        id: 'chunk-001',
        text: 'Contesto prima',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 14,
        pageStart: 2,
        pageEnd: 2,
      },
      {
        id: 'chunk-002',
        text: 'Contesto principale',
        headingPath: ['Intro', 'Dettaglio'],
        sequence: 1,
        startOffset: 15,
        endOffset: 34,
        pageStart: 10,
        pageEnd: 12,
      },
      {
        id: 'chunk-003',
        text: 'Approfondimento lontano',
        headingPath: ['Appendice'],
        sequence: 2,
        startOffset: 35,
        endOffset: 55,
        pageStart: 18,
        pageEnd: 20,
      },
    ],
  };

  assert.equal(
    getLessonSourcePageLabel({
      activeSection,
      documentIndex,
    }),
    'pag. 10-12, 18-20'
  );
});

test('resolveLessonSourceReferences keeps the original PDF identity, pages, and chunks', () => {
  const descriptors = buildCourseSourceDescriptors([
    { data: 'JVBERi0xLjQ=', mimeType: 'application/pdf', name: '01.pdf' },
    { data: 'JVBERi0xLjQ=', mimeType: 'application/pdf', name: '049.pdf' },
  ]);
  const activeSection: LessonNode = {
    id: 'lesson-final-source',
    kind: 'lesson',
    title: 'Lezione finale',
    description: 'Usa la fonte finale senza fonderla con le precedenti.',
    isCompleted: false,
    type: 'core',
    sourceReferences: [
      {
        chunkIds: ['chunk-049-a', 'chunk-049-b'],
        pageEnd: 12,
        pageStart: 11,
        sourceId: descriptors[1]?.id || '',
      },
    ],
  };

  const references = resolveLessonSourceReferences({
    activeSection,
    source: createProjectSourceFromDescriptors(descriptors),
  });

  assert.equal(references.length, 1);
  assert.equal(references[0]?.name, '049.pdf');
  assert.equal(references[0]?.sourceId, descriptors[1]?.id);
  assert.equal(references[0]?.pageStart, 11);
  assert.equal(references[0]?.pageEnd, 12);
  assert.deepEqual(references[0]?.chunkIds, ['chunk-049-a', 'chunk-049-b']);
  assert.equal(
    references.some(reference => reference.name.includes('merged')),
    false
  );
});

test('resolveLessonSourceReferences restores the original archive and exact lesson selectors', () => {
  const source: ProjectSource = {
    file: {
      data: 'UEs=',
      mimeType: 'application/zip',
      name: 'src.zip',
    },
    index: {
      entries: [
        { kind: 'directory', path: 'luanti/src' },
        {
          byteSize: 128,
          contentKind: 'text',
          kind: 'file',
          path: 'luanti/src/client.cpp',
        },
      ],
    },
    kind: 'archive',
    name: 'src.zip',
    ref: {
      byteSize: 256,
      hash: 'archive-hash',
      id: 'source-archive',
      mimeType: 'application/zip',
      name: 'src.zip',
      objectPath: 'sources/src.zip',
    },
  };
  const activeSection: LessonNode = {
    id: 'lesson-codebase',
    kind: 'lesson',
    title: 'Client',
    description: 'Architettura del client.',
    isCompleted: false,
    type: 'core',
    sourceArchiveSelectors: [
      { kind: 'file', path: 'luanti/src/client.cpp' },
      { kind: 'directory', path: 'luanti/src' },
    ],
  };

  const references = resolveLessonSourceReferences({ activeSection, source });

  assert.equal(references.length, 1);
  assert.equal(references[0]?.name, 'src.zip');
  assert.equal(references[0]?.sourceId, 'source-archive');
  assert.equal(references[0]?.kind, 'archive');
  assert.deepEqual(references[0]?.archiveSelectors, activeSection.sourceArchiveSelectors);
});

test('resolveLessonSourceReferences keeps legacy archive provenance without selectors', () => {
  const source: ProjectSource = {
    file: { data: '', mimeType: 'application/zip', name: 'legacy-codebase.zip' },
    index: { entries: [] },
    kind: 'archive',
    name: 'legacy-codebase.zip',
    ref: {
      byteSize: 512,
      hash: 'legacy-hash',
      id: 'legacy-archive-source',
      mimeType: 'application/zip',
      name: 'legacy-codebase.zip',
      objectPath: 'sources/legacy-codebase.zip',
    },
  };
  const activeSection: LessonNode = {
    description: 'Lezione creata prima dei selector per archivio.',
    id: 'legacy-lesson',
    isCompleted: true,
    kind: 'lesson',
    title: 'Architettura',
    type: 'core',
  };

  const references = resolveLessonSourceReferences({ activeSection, source });

  assert.equal(references.length, 1);
  assert.equal(references[0]?.name, 'legacy-codebase.zip');
  assert.equal(references[0]?.sourceId, 'legacy-archive-source');
  assert.equal(references[0]?.archiveSelectors, undefined);
});
