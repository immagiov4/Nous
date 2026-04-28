import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildPersistenceSignature } from '../../../services/projects/persistenceSignature.ts';
import { createEmptyWorkspaceDomainState } from '../../../services/workspace/domain.ts';
import type { WorkspaceDomainState } from '../../../types.ts';

test('buildPersistenceSignature only depends on persisted workspace domain state', () => {
  const state = createEmptyWorkspaceDomainState();
  const signatureA = buildPersistenceSignature(state);
  const signatureB = buildPersistenceSignature({
    ...state,
    learningPlan: {
      title: 'Percorso',
      summary: '',
      sections: [],
      backgroundMusicUrl: '',
    },
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
    learningPlan: {
      title: 'Percorso',
      summary: 'Sintesi',
      sections: [
        {
          id: 'section-1',
          title: 'Lezione',
          description: 'Descrizione',
          isCompleted: false,
          type: 'core',
          content: 'Contenuto',
        },
      ],
    },
  };

  const unchangedClone = { ...state };
  const changedClone: WorkspaceDomainState = {
    ...state,
    learningPlan: state.learningPlan
      ? {
          ...state.learningPlan,
          sections: state.learningPlan.sections.map(section =>
            section.id === 'section-1' ? { ...section, content: 'Contenuto aggiornato' } : section
          ),
        }
      : null,
  };

  assert.equal(buildPersistenceSignature(state), buildPersistenceSignature(unchangedClone));
  assert.notEqual(buildPersistenceSignature(state), buildPersistenceSignature(changedClone));
});
