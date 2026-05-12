import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { LessonNode, PdfTextIndex, ProjectSource } from '../../../types.ts';
import {
  buildContextSourceMaterial,
  getLessonSourcePageLabel,
} from '../../../utils/context/sourceMaterial.ts';

test('returns aggregated source text for codebase-backed projects', () => {
  const source: ProjectSource = {
    kind: 'codebase-bundle',
    name: 'notes.md',
    aggregatedText: '# Titolo\n\nContenuto sorgente',
    files: [],
    stats: {
      includedFileCount: 0,
      skippedFileCount: 0,
      truncatedFileCount: 0,
      totalCharacterCount: 27,
    },
  };

  const result = buildContextSourceMaterial({
    activeSection: null,
    documentIndex: null,
    source,
  });

  assert.equal(result.sourceKind, 'codebase-bundle');
  assert.equal(result.sourceName, 'notes.md');
  assert.match(result.sourceMaterial ?? '', /Contenuto sorgente/);
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
