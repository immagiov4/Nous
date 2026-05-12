import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createEmptyWorkspaceDomainState,
  selectActiveSectionContent,
  selectActiveSectionQuiz,
  selectMusicUrl,
  selectNeedsSourceFile,
  workspaceDomainReducer,
} from '../../../services/workspace/domain.ts';
import type { LearningPlan, WorkspaceDomainState } from '../../../types';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

const learningPlan: LearningPlan = buildTestLearningPlan(
  [
    buildTestLesson({
      id: 'lesson-1',
      title: 'Introduzione',
      description: 'Intro',
      content: 'Contenuto iniziale',
      quiz: [
        {
          question: 'Domanda',
          options: ['A', 'B', 'C', 'D'],
          correctIndex: 1,
        },
      ],
    }),
  ],
  {
    title: 'Percorso',
    summary: 'Sintesi',
    backgroundMusicUrl: 'https://example.com/music',
  }
);

const lesson = flattenLessons(learningPlan.modules)[0];

const nestedPlan: LearningPlan = buildTestLearningPlan(
  [
    buildTestLesson({
      id: 'lesson-1',
      title: 'Introduzione',
      description: 'Intro',
    }),
    buildTestLesson({
      id: 'lesson-1-deep',
      title: 'Dettaglio',
      description: 'Figlia',
      type: 'deep-dive',
      parentId: 'lesson-1',
    }),
    buildTestLesson({
      id: 'lesson-2',
      title: 'Seguito',
      description: 'Next',
    }),
  ],
  {
    title: 'Percorso',
    summary: 'Sintesi',
  }
);

const getLessonIds = (plan: LearningPlan | null): string[] =>
  flattenLessons(plan?.modules).map(section => section.id);

const buildState = (overrides: Partial<WorkspaceDomainState> = {}): WorkspaceDomainState => ({
  ...createEmptyWorkspaceDomainState(),
  learningPlan,
  activeSectionId: 'lesson-1',
  ...overrides,
});

test('selectors derive active section content, quiz and music from the learning plan', () => {
  const state = buildState();

  assert.equal(selectActiveSectionContent(state), 'Contenuto iniziale');
  assert.deepEqual(selectActiveSectionQuiz(state), lesson.quiz);
  assert.equal(selectMusicUrl(state), 'https://example.com/music');
});

test('empty workspace domain state starts without active learning data', () => {
  const state = createEmptyWorkspaceDomainState();

  assert.equal(state.learningPlan, null);
  assert.equal(state.activeSectionId, null);
});

test('needsSourceFile is derived instead of mutated manually', () => {
  assert.equal(selectNeedsSourceFile(buildState({ source: null, isLearnMode: false })), true);
  assert.equal(selectNeedsSourceFile(buildState({ source: null, isLearnMode: true })), false);
  assert.equal(
    selectNeedsSourceFile(
      buildState({
        source: {
          kind: 'pdf',
          file: {
            name: 'dispensa.pdf',
            mimeType: 'application/pdf',
            data: 'ZmFrZQ==',
          },
        },
      })
    ),
    false
  );
});

test('reducer updates the active section content inside the persisted learning plan', () => {
  const nextState = workspaceDomainReducer(buildState(), {
    type: 'update-active-section-content',
    content: 'Contenuto aggiornato',
  });

  assert.equal(flattenLessons(nextState.learningPlan?.modules)[0].content, 'Contenuto aggiornato');
  assert.equal(selectActiveSectionContent(nextState), 'Contenuto aggiornato');
});

test('reducer can mark a section as completed without extra duplicate state', () => {
  const nextState = workspaceDomainReducer(buildState(), {
    type: 'update-section',
    sectionId: 'lesson-1',
    updater: section => ({ ...section, isCompleted: true }),
  });

  assert.equal(flattenLessons(nextState.learningPlan?.modules)[0].isCompleted, true);
});

test('reducer inserts a new section after the full subtree of its parent', () => {
  const nextState = workspaceDomainReducer(
    buildState({
      learningPlan: nestedPlan,
    }),
    {
      type: 'insert-section-after',
      parentSectionId: 'lesson-1',
      section: buildTestLesson({
        id: 'lesson-1-deep-2',
        title: 'Nuovo dettaglio',
        description: 'Nuova figlia',
        type: 'deep-dive',
        parentId: 'lesson-1',
      }),
    }
  );

  assert.deepEqual(getLessonIds(nextState.learningPlan ?? null), [
    'lesson-1',
    'lesson-1-deep',
    'lesson-1-deep-2',
    'lesson-2',
  ]);
});
