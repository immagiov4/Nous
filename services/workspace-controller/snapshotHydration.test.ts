import assert from 'node:assert/strict';
import test from 'node:test';
import { AppState, type ProjectSnapshot } from '../../types.ts';
import { prepareSnapshotForHydration } from './snapshotHydration.ts';

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
    prepared.learningPlan?.sections[0]?.content,
    'Esempio:\n\n```cpp\nMapNode Map::getNode(v3s16 p, bool *is_valid_position)\n```\n\nLa funzione restituisce un nodo.'
  );
});