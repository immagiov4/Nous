import { describe, expect, test } from 'vitest';

import type { ProjectSnapshot } from '../../src/projects/types.js';
import {
  buildLessonGenerationSourceFingerprint,
  buildLessonGenerationTargetFingerprint,
} from '../../src/workflows/lessonGenerationAuthority.js';

const project = (): ProjectSnapshot => ({
  createdAt: '2026-07-29T20:00:00.000Z',
  documentIndex: {
    chunks: [{ id: 'chunk-1', sourceId: 'source-1', text: 'Contenuto originale' }],
  },
  id: 'project-1',
  lastOpenedAt: '2026-07-29T20:00:00.000Z',
  learningPlan: {
    generationNotes: 'Usa esempi concreti.',
    modules: [
      {
        children: [
          {
            description: 'Descrizione',
            id: 'lesson-1',
            primaryChunkIds: ['chunk-1'],
            title: 'Lezione',
          },
        ],
        id: 'module-1',
        title: 'Modulo',
      },
    ],
    title: 'Corso',
  },
  source: {
    kind: 'document',
    ref: { hash: 'a'.repeat(64), id: 'source-1' },
  },
  sourceKind: 'document',
  updatedAt: '2026-07-29T20:00:00.000Z',
  userProfile: { language: 'Italiano' },
  version: '4.1',
});

describe('lesson generation source authority', () => {
  test('changes when a generation input changes', () => {
    const initial = project();
    const changed = project();
    changed.documentIndex = {
      chunks: [{ id: 'chunk-1', sourceId: 'source-1', text: 'Contenuto aggiornato' }],
    };

    expect(buildLessonGenerationSourceFingerprint(initial, 'lesson-1')).not.toBe(
      buildLessonGenerationSourceFingerprint(changed, 'lesson-1')
    );
  });

  test('ignores generated lesson output and project timestamps', () => {
    const initial = project();
    const changed = project();
    const lesson = changed.learningPlan?.modules?.[0]?.children?.[0];
    if (!lesson) throw new Error('Missing test lesson.');
    Object.assign(lesson, {
      content: 'Nuova lezione generata',
      contentBlocks: [{ markdown: 'Nuova lezione generata', type: 'markdown' }],
      lastGenerationRunId: 'run-2',
      quiz: [],
    });
    changed.updatedAt = '2026-07-29T21:00:00.000Z';

    expect(buildLessonGenerationSourceFingerprint(changed, 'lesson-1')).toBe(
      buildLessonGenerationSourceFingerprint(initial, 'lesson-1')
    );
    expect(buildLessonGenerationTargetFingerprint(changed, 'lesson-1')).not.toBe(
      buildLessonGenerationTargetFingerprint(initial, 'lesson-1')
    );
  });
});
