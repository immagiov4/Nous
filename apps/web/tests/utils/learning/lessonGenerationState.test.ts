import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { FileData, LearningPlan, SyllabusItem } from '../../../types';
import { resolveLessonGenerationState } from '../../../utils/learning/lessonGenerationState.ts';

const pdfFile: FileData = {
  name: 'dispensa.pdf',
  mimeType: 'application/pdf',
  data: 'ZmFrZQ==',
};

const regularPlan: LearningPlan = {
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

const nestedPlan: LearningPlan = {
  ...regularPlan,
  sections: [
    ...regularPlan.sections,
    {
      id: 'lesson-2',
      title: 'Approfondimento',
      description: 'Dettagli',
      isCompleted: false,
      type: 'deep-dive',
      parentId: 'lesson-1',
    },
  ],
};

const syllabus: SyllabusItem[] = [
  {
    id: 'module-1',
    title: 'Modulo 1',
    description: '',
    type: 'module',
    status: 'ready',
  },
];

test('blocks lesson generation when there is no source file and no learn-mode context', () => {
  assert.equal(
    resolveLessonGenerationState({
      file: null,
      isLearnMode: false,
      learningPlan: regularPlan,
      syllabus: [],
    }),
    'blocked-missing-source'
  );
});

test('uses learn-mode generation when the project already behaves like a generated curriculum', () => {
  assert.equal(
    resolveLessonGenerationState({
      file: null,
      isLearnMode: true,
      learningPlan: regularPlan,
      syllabus: [],
    }),
    'learn-mode'
  );

  assert.equal(
    resolveLessonGenerationState({
      file: null,
      isLearnMode: false,
      learningPlan: nestedPlan,
      syllabus: [],
    }),
    'learn-mode'
  );

  assert.equal(
    resolveLessonGenerationState({
      file: null,
      isLearnMode: false,
      learningPlan: regularPlan,
      syllabus,
    }),
    'learn-mode'
  );
});

test('uses the source-backed flow when a source file is present', () => {
  assert.equal(
    resolveLessonGenerationState({
      file: pdfFile,
      isLearnMode: false,
      learningPlan: regularPlan,
      syllabus: [],
    }),
    'source-backed'
  );
});
