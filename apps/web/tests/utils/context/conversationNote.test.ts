import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildConversationNoteSaveCandidates } from '../../../utils/context/conversationNote.ts';

test('keeps a single candidate when the refined selection matches the original anchor', () => {
  const candidates = buildConversationNoteSaveCandidates({
    anchor: {
      contextAfter: ' dopo',
      contextBefore: 'prima ',
      selectedText: ' Concetto chiave ',
      selectedTextStart: 42,
    },
    toolInput: {
      note: ' Nota sintetica ',
      selectedText: 'Concetto chiave',
    },
  });

  assert.deepEqual(candidates, [
    {
      contextAfter: 'dopo',
      contextBefore: 'prima',
      fallbackSelection: {
        contextAfter: 'dopo',
        contextBefore: 'prima',
        selectedText: 'Concetto chiave',
        selectedTextStart: 42,
      },
      note: 'Nota sintetica',
      selectedText: 'Concetto chiave',
      selectedTextStart: 42,
    },
  ]);
});

test('adds a fallback candidate with the original anchored selection when the model refines too much', () => {
  const candidates = buildConversationNoteSaveCandidates({
    anchor: {
      contextAfter: 'definisce il comportamento',
      contextBefore: 'La funzione pure',
      selectedText: 'non muta lo stato',
      selectedTextStart: 128,
    },
    toolInput: {
      contextAfter: 'il comportamento',
      contextBefore: 'funzione',
      note: 'Riassunto finale',
      selectedText: 'non muta',
    },
  });

  assert.deepEqual(candidates, [
    {
      contextAfter: 'il comportamento',
      contextBefore: 'funzione',
      fallbackSelection: {
        contextAfter: 'definisce il comportamento',
        contextBefore: 'La funzione pure',
        selectedText: 'non muta lo stato',
        selectedTextStart: 128,
      },
      note: 'Riassunto finale',
      selectedText: 'non muta',
    },
    {
      contextAfter: 'definisce il comportamento',
      contextBefore: 'La funzione pure',
      fallbackSelection: {
        contextAfter: 'definisce il comportamento',
        contextBefore: 'La funzione pure',
        selectedText: 'non muta lo stato',
        selectedTextStart: 128,
      },
      note: 'Riassunto finale',
      selectedText: 'non muta lo stato',
      selectedTextStart: 128,
    },
  ]);
});
