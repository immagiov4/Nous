import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEmptyWorkspaceDomainState,
  selectActiveSectionContent,
  selectActiveSectionQuiz,
  selectMusicUrl,
  selectNeedsSourceFile,
  workspaceDomainReducer,
} from './workspaceDomain.ts';
import type { LearningPlan, WorkspaceDomainState } from '../types';

const learningPlan: LearningPlan = {
  title: 'Percorso',
  summary: 'Sintesi',
  backgroundMusicUrl: 'https://example.com/music',
  sections: [
    {
      id: 'lesson-1',
      title: 'Introduzione',
      description: 'Intro',
      isCompleted: false,
      type: 'core',
      content: 'Contenuto iniziale',
      quiz: [
        {
          question: 'Domanda',
          options: ['A', 'B', 'C', 'D'],
          correctIndex: 1,
        },
      ],
    },
  ],
};

const buildState = (overrides: Partial<WorkspaceDomainState> = {}): WorkspaceDomainState => ({
  ...createEmptyWorkspaceDomainState(),
  learningPlan,
  activeSectionId: 'lesson-1',
  ...overrides,
});

test('selectors derive active section content, quiz and music from the learning plan', () => {
  const state = buildState();

  assert.equal(selectActiveSectionContent(state), 'Contenuto iniziale');
  assert.deepEqual(selectActiveSectionQuiz(state), learningPlan.sections[0].quiz);
  assert.equal(selectMusicUrl(state), 'https://example.com/music');
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

  assert.equal(nextState.learningPlan?.sections[0].content, 'Contenuto aggiornato');
  assert.equal(selectActiveSectionContent(nextState), 'Contenuto aggiornato');
});

test('reducer can mark a section as completed without extra duplicate state', () => {
  const nextState = workspaceDomainReducer(buildState(), {
    type: 'update-section',
    sectionId: 'lesson-1',
    updater: section => ({ ...section, isCompleted: true }),
  });

  assert.equal(nextState.learningPlan?.sections[0].isCompleted, true);
});
