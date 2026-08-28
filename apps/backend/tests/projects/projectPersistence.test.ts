import { decodeProjectSnapshotWire } from '@shared/projectSnapshotWire';
import { expect, test } from 'vitest';

import { mergeProjectSnapshotRow } from '../../src/projects/projectPersistence.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';

const storedSnapshot = (contentBlocks: unknown[]): Omit<ProjectSnapshot, 'documentIndex'> => ({
  activeSectionId: 'lesson-1',
  createdAt: '2026-08-28T12:00:00.000Z',
  id: 'project-1',
  isLearnMode: true,
  lastOpenedAt: '2026-08-28T12:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [
          {
            content: 'Contenuto legacy recuperabile',
            contentBlocks,
            id: 'lesson-1',
            kind: 'lesson',
            title: 'Lezione',
          },
        ],
        id: 'module-1',
        title: 'Modulo',
      },
    ],
    title: 'Corso',
  },
  source: null,
  sourceKind: 'learn-mode',
  state: 'READING',
  syllabus: [],
  updatedAt: '2026-08-28T12:00:00.000Z',
  userProfile: { language: 'Italiano' },
  version: '4.1',
});

test.each([
  ['empty', []],
  ['malformed', [null]],
])('stored snapshot recovery clears %s historical lesson blocks', (_description, contentBlocks) => {
  const restored = mergeProjectSnapshotRow({
    document_index: null,
    snapshot: storedSnapshot(contentBlocks),
  });
  const lesson = restored.learningPlan?.modules?.[0]?.children?.[0];

  expect(lesson?.content).toBe('Contenuto legacy recuperabile');
  expect(lesson?.contentBlocks).toBeNull();
});

test('historical recovery stays limited to stored snapshots with legacy content', () => {
  expect(() => decodeProjectSnapshotWire(storedSnapshot([]))).toThrow(
    /blocchi contenuto lezione senza testo Markdown/iu
  );

  const unrecoverable = storedSnapshot([null]);
  const lesson = unrecoverable.learningPlan?.modules?.[0]?.children?.[0];
  if (!lesson) throw new Error('Missing historical test lesson.');
  delete lesson.content;

  expect(() => mergeProjectSnapshotRow({ document_index: null, snapshot: unrecoverable })).toThrow(
    /blocco contenuto lezione non valido/iu
  );
});
