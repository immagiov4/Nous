import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  acknowledgeSectionPatch,
  buildAutosaveSignature,
  buildPersistenceSignature,
} from '../../../services/projects/persistenceSignature.ts';
import { createEmptyWorkspaceDomainState } from '../../../services/workspace/domain.ts';
import type { WorkspaceDomainState } from '../../../types.ts';
import { updateLessons } from '../../../utils/learning/pathNodes.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

test('buildPersistenceSignature only depends on persisted workspace domain state', () => {
  const state = createEmptyWorkspaceDomainState();
  const signatureA = buildPersistenceSignature(state);
  const signatureB = buildPersistenceSignature({
    ...state,
    learningPlan: buildTestLearningPlan([], { backgroundMusicUrl: '' }),
  });

  assert.notEqual(signatureA, signatureB);
  assert.equal(signatureA, buildPersistenceSignature(createEmptyWorkspaceDomainState()));
});

test('buildPersistenceSignature detects persisted changes in large referenced state', () => {
  const state: WorkspaceDomainState = {
    ...createEmptyWorkspaceDomainState(),
    documentAssets: {
      kind: 'pdf',
      parsedAt: '2026-04-28T00:00:00.000Z',
      imageCount: 1,
      sourceHash: 'source-hash',
      usedImages: [
        {
          id: 'image-1',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${'a'.repeat(1024)}`,
          textBefore: 'before',
          textAfter: 'after',
          sourceOrder: 1,
          pageNumber: 2,
        },
      ],
    },
    learningPlan: buildTestLearningPlan(
      [
        buildTestLesson({
          id: 'section-1',
          title: 'Lezione',
          description: 'Descrizione',
          content: 'Contenuto',
        }),
      ],
      { summary: 'Sintesi' }
    ),
  };

  const unchangedClone = { ...state };
  const changedClone: WorkspaceDomainState = {
    ...state,
    learningPlan: state.learningPlan
      ? {
          ...state.learningPlan,
          modules: updateLessons(state.learningPlan.modules, section =>
            section.id === 'section-1' ? { ...section, content: 'Contenuto aggiornato' } : section
          ),
        }
      : null,
  };

  assert.equal(buildPersistenceSignature(state), buildPersistenceSignature(unchangedClone));
  assert.notEqual(buildPersistenceSignature(state), buildPersistenceSignature(changedClone));
});

test('internal signatures ignore object key order and omitted optional fields while preserving source identity and array order', () => {
  const first = buildTestLesson({
    id: 'first',
    annotations: undefined,
    quizState: { answers: [0], isSubmitted: false },
  });
  const second = buildTestLesson({ id: 'second' });
  const state: WorkspaceDomainState = {
    ...createEmptyWorkspaceDomainState(),
    source: {
      kind: 'pdf',
      file: { name: 'synthetic.pdf', mimeType: 'application/pdf', data: 'c3ludGhldGlj' },
    },
    learningPlan: buildTestLearningPlan([first, second]),
  };
  const persistedPayload = JSON.stringify(state);
  const clone: WorkspaceDomainState = JSON.parse(persistedPayload);
  clone.source = state.source;
  clone.learningPlan = Object.fromEntries(
    Object.entries(clone.learningPlan ?? {}).reverse()
  ) as WorkspaceDomainState['learningPlan'];
  assert.equal(buildAutosaveSignature(state), buildAutosaveSignature(clone));
  assert.equal(buildPersistenceSignature(state), buildPersistenceSignature(clone));
  assert.ok(state.source);
  assert.notEqual(
    buildAutosaveSignature(state),
    buildAutosaveSignature({ ...state, source: { ...state.source } })
  );
  const reversed = { ...state, learningPlan: buildTestLearningPlan([second, first]) };
  assert.notEqual(buildAutosaveSignature(state), buildAutosaveSignature(reversed));
  const reorderedAnswers = {
    ...state,
    learningPlan: buildTestLearningPlan([
      { ...first, quizState: { answers: [1, 0], isSubmitted: false } },
      second,
    ]),
  };
  const originalAnswers = {
    ...state,
    learningPlan: buildTestLearningPlan([
      { ...first, quizState: { answers: [0, 1], isSubmitted: false } },
      second,
    ]),
  };
  assert.notEqual(
    buildAutosaveSignature(reorderedAnswers),
    buildAutosaveSignature(originalAnswers)
  );
  acknowledgeSectionPatch(buildAutosaveSignature(state), { sectionId: 'first', annotations: [] });
  assert.equal(JSON.stringify(state), persistedPayload);
  assert.equal(Object.hasOwn(first, 'annotations'), true);
});
