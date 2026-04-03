import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createEmptyWorkspaceDomainState } from '../../../services/workspace/domain.ts';
import { buildPersistenceSignature } from '../../../services/projects/persistenceSignature.ts';

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
