import { describe, expect, test } from 'vitest';

import type { ProjectSnapshot } from '../../src/projects/types.js';
import { buildLessonPedagogicalContext } from '../../src/services/lessonGenerationPreparation.js';
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

  test('prompt context and fingerprint read the same parent lesson', () => {
    const withParentDescription = (description: string): ProjectSnapshot => ({
      ...project(),
      learningPlan: {
        sections: [
          { description, id: 'parent-1', title: 'Lezione madre' },
          { id: 'child-1', parentId: 'parent-1', title: 'Approfondimento' },
        ],
        title: 'Corso',
      },
    });
    const initial = withParentDescription('Descrizione iniziale');
    const changed = withParentDescription('Descrizione aggiornata');
    const child = (snapshot: ProjectSnapshot) => {
      const section = snapshot.learningPlan?.sections?.[1];
      if (!section) throw new Error('Missing test sublesson.');
      return section;
    };

    expect(buildLessonPedagogicalContext(initial, child(initial))).toContain(
      'Descrizione iniziale'
    );
    expect(buildLessonPedagogicalContext(changed, child(changed))).toContain(
      'Descrizione aggiornata'
    );
    expect(buildLessonGenerationSourceFingerprint(initial, 'child-1')).not.toBe(
      buildLessonGenerationSourceFingerprint(changed, 'child-1')
    );
  });

  // Fingerprints are persisted with in-flight runs; a serialization change would
  // make every running generation look stale.
  test('keeps persisted fingerprint values stable across plan shapes', () => {
    const base = {
      createdAt: 'x',
      id: 'p',
      lastOpenedAt: 'x',
      sourceKind: 'document',
      updatedAt: 'x',
      userProfile: { goal: 'g', language: 'Italiano' },
      version: '4.1',
    } as unknown as ProjectSnapshot;
    const modulePlan = {
      ...base,
      learningPlan: {
        generationNotes: 'n',
        modules: [
          {
            children: [
              { content: 'x', id: 'l1', isCompleted: true, title: 'A' },
              { description: 'd', id: 'l2', parentId: 'l1', title: 'B' },
            ],
            id: 'm',
            title: 'M',
          },
        ],
        title: 'C',
      },
      researchCoursePlan: { lessons: [{ goal: 'r', id: 'l2' }, 'junk'] },
      syllabus: [{ children: [{ id: 'l2', title: 'syl' }], id: 's' }],
    } as unknown as ProjectSnapshot;
    const flatPlan = {
      ...base,
      learningPlan: {
        sections: [
          { content: 'pc', description: 'pd', id: 'p1', title: 'P' },
          { id: 'c1', parentId: 'p1', title: 'C1' },
        ],
        title: 'C',
      },
    } as unknown as ProjectSnapshot;

    expect(buildLessonGenerationSourceFingerprint(modulePlan, 'l2')).toBe(
      '23e1c2a7d9231e380ba1db52646a824c584c104e62d06533662107c5fdfebe87'
    );
    expect(buildLessonGenerationSourceFingerprint(flatPlan, 'c1')).toBe(
      '227191c9add6d638172c25309c3f4432eb12b08614f9a2cd3bd0e0cdf94c5a94'
    );
  });
});
