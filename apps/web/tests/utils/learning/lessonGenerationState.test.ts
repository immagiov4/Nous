import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { FileData, LearningPlan, SyllabusItem } from '../../../types';
import { resolveLessonGenerationState } from '../../../utils/learning/lessonGenerationState.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

const pdfFile: FileData = {
  name: 'dispensa.pdf',
  mimeType: 'application/pdf',
  data: 'ZmFrZQ==',
};

const regularPlan: LearningPlan = {
  ...buildTestLearningPlan([buildTestLesson()]),
};

const nestedPlan: LearningPlan = {
  ...buildTestLearningPlan([
    buildTestLesson(),
    buildTestLesson({
      id: 'lesson-2',
      title: 'Approfondimento',
      description: 'Dettagli',
      type: 'deep-dive',
      parentId: 'lesson-1',
    }),
  ]),
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
      hasResearchContext: true,
      isLearnMode: false,
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

test('uses the source-backed flow when a source file or tool-backed archive is present', () => {
  assert.equal(
    resolveLessonGenerationState({
      file: null,
      hasToolBackedSource: true,
      isLearnMode: false,
      learningPlan: regularPlan,
      syllabus: [],
    }),
    'source-backed'
  );

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
