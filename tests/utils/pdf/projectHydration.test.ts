import assert from 'node:assert/strict';
import { test } from 'vitest';
import { getPdfProjectHydrationState, needsPdfProjectHydration } from '../../../utils/pdf/projectHydration.ts';
import type { FileData, LearningPlan, PdfTextIndex } from '../../../types';

const pdfFile: FileData = {
  name: 'dispensa.pdf',
  mimeType: 'application/pdf',
  data: 'ZmFrZQ==',
};

const basePlan: LearningPlan = {
  title: 'Percorso',
  summary: '',
  sections: [
    {
      id: 'lesson-1',
      title: 'Lezione 1',
      description: 'Intro',
      isCompleted: false,
      type: 'core',
    },
  ],
};

const readyIndex: PdfTextIndex = {
  kind: 'pdf-text-index',
  parsedAt: '2026-03-20T10:00:00.000Z',
  sourceHash: 'hash-1',
  chunks: [
    {
      id: 'chunk-001',
      text: 'Contenuto',
      headingPath: ['Intro'],
      sequence: 0,
      startOffset: 0,
      endOffset: 9,
    },
  ],
};

const largeReadyIndex: PdfTextIndex = {
  kind: 'pdf-text-index',
  parsedAt: '2026-03-20T10:00:00.000Z',
  sourceHash: 'hash-2',
  chunks: Array.from({ length: 8 }, (_, index) => ({
    id: `chunk-00${index + 1}`,
    text: `Chunk ${index + 1}`,
    headingPath: [`Chapter ${index + 1}`],
    sequence: index,
    startOffset: index * 10,
    endOffset: index * 10 + 8,
  })),
};

test('stays idle for non-pdf or fileless projects', () => {
  assert.equal(getPdfProjectHydrationState(null, basePlan, null), 'idle');
  assert.equal(
    getPdfProjectHydrationState(
      {
        name: 'repo.zip',
        mimeType: 'application/zip',
        data: 'ZmFrZQ==',
      },
      basePlan,
      null
    ),
    'idle'
  );
});

test('requires a document index when a pdf-backed project has a plan but no chunks', () => {
  assert.equal(getPdfProjectHydrationState(pdfFile, basePlan, null), 'missing-document-index');
  assert.equal(needsPdfProjectHydration(pdfFile, basePlan, null), true);
});

test('requires chunk mappings when the document index exists but lessons are still unmapped', () => {
  assert.equal(
    getPdfProjectHydrationState(pdfFile, basePlan, readyIndex),
    'missing-primary-chunk-mappings'
  );
});

test('is ready only when the pdf plan already has a chunk index and primary mappings', () => {
  const mappedPlan: LearningPlan = {
    ...basePlan,
    sections: basePlan.sections.map(section => ({
      ...section,
      primaryChunkIds: ['chunk-001'],
    })),
  };

  assert.equal(getPdfProjectHydrationState(pdfFile, mappedPlan, readyIndex), 'ready');
  assert.equal(needsPdfProjectHydration(pdfFile, mappedPlan, readyIndex), false);
});

test('treats legacy fallback mappings as stale when most lessons point to the first two chunks', () => {
  const stalePlan: LearningPlan = {
    title: 'Percorso',
    summary: '',
    sections: Array.from({ length: 5 }, (_, index) => ({
      id: `lesson-${index + 1}`,
      title: `Lezione ${index + 1}`,
      description: 'Intro',
      isCompleted: false,
      type: 'core' as const,
      primaryChunkIds: ['chunk-001', 'chunk-002'],
    })),
  };

  assert.equal(
    getPdfProjectHydrationState(pdfFile, stalePlan, largeReadyIndex),
    'missing-primary-chunk-mappings'
  );
  assert.equal(needsPdfProjectHydration(pdfFile, stalePlan, largeReadyIndex), true);
});

test('does not flag small documents that only have the first chunks available', () => {
  const smallDocPlan: LearningPlan = {
    title: 'Percorso',
    summary: '',
    sections: Array.from({ length: 4 }, (_, index) => ({
      id: `lesson-${index + 1}`,
      title: `Lezione ${index + 1}`,
      description: 'Intro',
      isCompleted: false,
      type: 'core' as const,
      primaryChunkIds: ['chunk-001'],
    })),
  };

  assert.equal(getPdfProjectHydrationState(pdfFile, smallDocPlan, readyIndex), 'ready');
  assert.equal(needsPdfProjectHydration(pdfFile, smallDocPlan, readyIndex), false);
});
