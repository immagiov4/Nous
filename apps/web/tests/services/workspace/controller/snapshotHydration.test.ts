import assert from 'node:assert/strict';
import { test } from 'vitest';
import { prepareSnapshotForHydration } from '../../../../services/workspace/controller/snapshotHydration.ts';
import { AppState, type ProjectSnapshot } from '../../../../types.ts';
import { flattenLessons } from '../../../../utils/learning/pathNodes.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../../helpers/learningPlan.ts';

const CURRENT_LEGACY_LABORATORY_SCHEMA_VERSION = 3;

test('prepareSnapshotForHydration normalizes persisted lesson markdown code blocks', () => {
  const snapshot: ProjectSnapshot = {
    id: 'project-1',
    version: '1',
    sourceKind: 'document',
    state: AppState.READING,
    source: null,
    learningPlan: buildTestLearningPlan(
      [
        buildTestLesson({
          id: 'section-1',
          title: 'Ownership',
          description: 'Dettagli',
          content:
            'Esempio:\n\ncpp\nMapNode Map::getNode(v3s16 p, bool *is_valid_position)\n\nLa funzione restituisce un nodo.',
        }),
      ],
      { title: 'Percorso', summary: 'Test' }
    ),
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: 'section-1',
    createdAt: '2026-03-23T10:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
    lastOpenedAt: '2026-03-23T10:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const prepared = prepareSnapshotForHydration(snapshot);

  assert.equal(
    flattenLessons(prepared.learningPlan?.modules)[0]?.content,
    'Esempio:\n\n```cpp\nMapNode Map::getNode(v3s16 p, bool *is_valid_position)\n```\n\nLa funzione restituisce un nodo.'
  );
});

test('prepareSnapshotForHydration migrates legacy highlight marks into persistent annotations', () => {
  const snapshot: ProjectSnapshot = {
    id: 'project-annotations',
    version: '1',
    sourceKind: 'document',
    state: AppState.READING,
    source: null,
    learningPlan: buildTestLearningPlan(
      [
        buildTestLesson({
          id: 'section-1',
          title: 'Ownership',
          description: 'Dettagli',
          content: 'Testo con <mark>focus</mark> persistente.',
        }),
      ],
      { title: 'Percorso', summary: 'Test' }
    ),
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: 'section-1',
    createdAt: '2026-03-23T10:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
    lastOpenedAt: '2026-03-23T10:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const prepared = prepareSnapshotForHydration(snapshot);
  const migratedSection = flattenLessons(prepared.learningPlan?.modules)[0];

  assert.match(migratedSection?.content || '', /<mark data-nous-annotation-id="annotation-/);
  assert.equal(migratedSection?.annotations?.length, 1);
  assert.equal(migratedSection?.annotations?.[0]?.note, '');
});

test('prepareSnapshotForHydration drops legacy laboratory payloads that miss the guided support fields', () => {
  const snapshot = {
    id: 'project-lab-legacy',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: null,
    learningPlan: {
      title: 'Percorso',
      summary: 'Test',
      sections: [
        {
          id: 'section-1',
          title: 'Ownership',
          description: 'Dettagli',
          type: 'core',
          isCompleted: false,
          content: 'Contenuto pronto.',
        },
      ],
    },
    laboratory: {
      errorMessage: undefined,
      exercises: [
        {
          attachments: [],
          approachMarkdown: '',
          brief: 'Analizza il caso.',
          evaluation: null,
          exampleMarkdown: '',
          generatedAt: '2026-03-23T10:00:00.000Z',
          id: 'lab-1',
          internalNotes: [],
          instructionsMarkdown: '## Traccia',
          requirements: [],
          title: 'Esercizio 1',
          updatedAt: '2026-03-23T10:00:00.000Z',
        },
      ],
      generatedAt: '2026-03-23T10:00:00.000Z',
      schemaVersion: CURRENT_LEGACY_LABORATORY_SCHEMA_VERSION - 1,
      status: 'ready',
      summary: 'Laboratorio vecchio',
      title: 'Laboratorio',
      updatedAt: '2026-03-23T10:00:00.000Z',
    },
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    activeLaboratoryExerciseId: 'lab-1',
    createdAt: '2026-03-23T10:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
    lastOpenedAt: '2026-03-23T10:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  } as unknown as ProjectSnapshot;

  const prepared = prepareSnapshotForHydration(snapshot);

  const preparedRecord = prepared as unknown as Record<string, unknown>;
  assert.equal(preparedRecord.laboratory, undefined);
  assert.equal(preparedRecord.activeLaboratoryExerciseId, undefined);
  assert.equal(prepared.activeSectionId, 'section-1');
});

test('prepareSnapshotForHydration resets abandoned pending laboratory generation', () => {
  const snapshot = {
    id: 'project-lab-pending',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: null,
    learningPlan: {
      title: 'Percorso',
      summary: 'Test',
      sections: [
        {
          id: 'section-1',
          title: 'Ownership',
          description: 'Dettagli',
          type: 'core',
          isCompleted: false,
          content: 'Contenuto pronto.',
        },
      ],
    },
    laboratory: {
      errorMessage: undefined,
      exercises: [],
      generatedAt: undefined,
      schemaVersion: CURRENT_LEGACY_LABORATORY_SCHEMA_VERSION,
      status: 'pending',
      summary: '',
      title: 'Laboratorio',
      updatedAt: '2026-03-23T10:00:00.000Z',
    },
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    activeLaboratoryExerciseId: null,
    createdAt: '2026-03-23T10:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
    lastOpenedAt: '2026-03-23T10:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  } as unknown as ProjectSnapshot;

  const prepared = prepareSnapshotForHydration(snapshot);

  const preparedRecord = prepared as unknown as Record<string, unknown>;
  assert.equal(preparedRecord.laboratory, undefined);
  assert.equal(preparedRecord.activeLaboratoryExerciseId, undefined);
  assert.equal(prepared.activeSectionId, 'section-1');
});
