import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CURRENT_LABORATORY_SCHEMA_VERSION } from '../../../../services/laboratory/state.ts';
import { prepareSnapshotForHydration } from '../../../../services/workspace/controller/snapshotHydration.ts';
import { AppState, type ProjectSnapshot } from '../../../../types.ts';

test('prepareSnapshotForHydration normalizes persisted lesson markdown code blocks', () => {
  const snapshot: ProjectSnapshot = {
    id: 'project-1',
    version: '1',
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
          content:
            'Esempio:\n\ncpp\nMapNode Map::getNode(v3s16 p, bool *is_valid_position)\n\nLa funzione restituisce un nodo.',
        },
      ],
    },
    laboratory: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: 'section-1',
    activeLaboratoryExerciseId: null,
    createdAt: '2026-03-23T10:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
    lastOpenedAt: '2026-03-23T10:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const prepared = prepareSnapshotForHydration(snapshot);

  assert.equal(
    prepared.learningPlan?.sections[0]?.content,
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
          content: 'Testo con <mark>focus</mark> persistente.',
        },
      ],
    },
    laboratory: null,
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: 'section-1',
    activeLaboratoryExerciseId: null,
    createdAt: '2026-03-23T10:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
    lastOpenedAt: '2026-03-23T10:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const prepared = prepareSnapshotForHydration(snapshot);
  const migratedSection = prepared.learningPlan?.sections[0];

  assert.match(migratedSection?.content || '', /<mark data-nous-annotation-id="annotation-/);
  assert.equal(migratedSection?.annotations?.length, 1);
  assert.equal(migratedSection?.annotations?.[0]?.note, '');
});

test('prepareSnapshotForHydration drops legacy laboratory payloads that miss the guided support fields', () => {
  const snapshot: ProjectSnapshot = {
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
      schemaVersion: CURRENT_LABORATORY_SCHEMA_VERSION - 1,
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
  };

  const prepared = prepareSnapshotForHydration(snapshot);

  assert.equal(prepared.laboratory, null);
  assert.equal(prepared.activeLaboratoryExerciseId, null);
  assert.equal(prepared.activeSectionId, 'section-1');
});

test('prepareSnapshotForHydration resets abandoned pending laboratory generation', () => {
  const snapshot: ProjectSnapshot = {
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
      schemaVersion: CURRENT_LABORATORY_SCHEMA_VERSION,
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
  };

  const prepared = prepareSnapshotForHydration(snapshot);

  assert.equal(prepared.laboratory?.status, 'idle');
  assert.match(prepared.laboratory?.summary || '', /generazione precedente/i);
  assert.equal(prepared.activeLaboratoryExerciseId, null);
  assert.equal(prepared.activeSectionId, 'section-1');
});
