import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildConversationNoteSaveCandidates,
  hasAnchorableConversationNoteCandidate,
} from '../../../utils/context/conversationNote.ts';

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

test('rejects note proposals whose text is absent or only belongs to an image', () => {
  const content = 'Testo della lezione.\n\n![Schema della pipeline](asset://pipeline)';

  assert.equal(
    hasAnchorableConversationNoteCandidate(content, { selectedText: 'Testo assente' }),
    false
  );
  assert.equal(hasAnchorableConversationNoteCandidate(content, { selectedText: '  ' }), false);
  assert.equal(
    hasAnchorableConversationNoteCandidate(content, { selectedText: 'Schema della pipeline' }),
    false
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate(content, { selectedText: 'Testo della lezione' }),
    true
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate('Usa ![x] come notazione; vedi esempio (sotto).', {
      selectedText: '![x] come notazione',
    }),
    true
  );
});

test('rejects note proposals whose text exists only in an unsupported viewer placeholder', () => {
  const placeholders = [
    '{{PDF_IMAGE:asset-1|alt=Schema durevole}}',
    '{{VISUAL_EXAMPLE:visual-1|title=Schema durevole}}',
    '{{YOUTUBE_CLIP_SOURCE:1|title=Schema durevole}}',
    '{{INLINE_QUIZ:Schema durevole}}',
    '{{VISUAL_SLOT:slot-1|title=Schema durevole}}',
  ];

  placeholders.forEach(content => {
    assert.equal(
      hasAnchorableConversationNoteCandidate(content, { selectedText: 'Schema durevole' }),
      false
    );
  });
});

test('rejects candidates that resolve only a visible fragment around protected text', () => {
  assert.equal(
    hasAnchorableConversationNoteCandidate(
      'Testo [fonte](https://example.com/percorso-nascosto) conclusivo.',
      { selectedText: 'Testo percorso nascosto conclusivo' }
    ),
    false
  );
});

test('accepts complete candidates through loose case and accent normalization', () => {
  assert.equal(
    hasAnchorableConversationNoteCandidate('Il Caffè resume il concetto.', {
      selectedText: 'CAFFE RESUME',
    }),
    true
  );
});

test('accepts complete candidates through KaTeX selection normalization', () => {
  assert.equal(
    hasAnchorableConversationNoteCandidate('Ridurre soprattutto $T_{\\text{cluster}}$ accelera.', {
      selectedText: 'Ridurre soprattutto TclusterT_{\\text{cluster}}Tcluster accelera.',
    }),
    true
  );
});

test('rejects candidates found only in a reference definition', () => {
  assert.equal(
    hasAnchorableConversationNoteCandidate(
      '![Schema][schema]\n\n[schema]: https://example.com/percorso-nascosto',
      { selectedText: 'percorso nascosto' }
    ),
    false
  );
});

test('rejects candidates found only in a multiline reference definition title', () => {
  assert.equal(
    hasAnchorableConversationNoteCandidate('[ref]: /image.png\n  "Titolo nascosto"', {
      selectedText: 'Titolo nascosto',
    }),
    false
  );
});

test('rejects candidates that name non-text Markdown block syntax', () => {
  assert.equal(hasAnchorableConversationNoteCandidate('---', { selectedText: '---' }), false);
  assert.equal(
    hasAnchorableConversationNoteCandidate('| Header |\n| --- |\n| Value |', {
      selectedText: '| --- |',
    }),
    false
  );
});

test('distinguishes visible footnote content from nested fenced code', () => {
  assert.equal(
    hasAnchorableConversationNoteCandidate('Testo[^nota]\n\n[^nota]: Contenuto visibile', {
      selectedText: 'Contenuto visibile',
    }),
    true
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate('> ~~~md\n> [falso]: /contenuto-nel-codice\n> ~~~', {
      selectedText: 'contenuto nel codice',
    }),
    false
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate('    contenuto nel codice indentato', {
      selectedText: 'contenuto nel codice indentato',
    }),
    true
  );
});

test('anchors renderer-normalized prose and rejects backslash-math-only text', () => {
  assert.equal(
    hasAnchorableConversationNoteCandidate('    Frase visibile normalizzata.', {
      selectedText: 'Frase visibile normalizzata',
    }),
    true
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate(String.raw`Formula \(contenuto protetto\).`, {
      selectedText: 'contenuto protetto',
    }),
    false
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate(String.raw`<span>\(visible\)</span>`, {
      selectedText: 'visible',
    }),
    false
  );
});

test('does not inherit stale boundary context when the proposed text changes', () => {
  const candidates = buildConversationNoteSaveCandidates({
    anchor: {
      contextAfter: 'contesto vecchio dopo',
      contextBefore: 'contesto vecchio prima',
      selectedText: 'passaggio originale',
      selectedTextStart: 10,
    },
    toolInput: { note: 'Nota', selectedText: 'passaggio raffinato' },
  });

  assert.deepEqual(candidates[0], {
    fallbackSelection: {
      contextAfter: 'contesto vecchio dopo',
      contextBefore: 'contesto vecchio prima',
      selectedText: 'passaggio originale',
      selectedTextStart: 10,
    },
    note: 'Nota',
    selectedText: 'passaggio raffinato',
  });
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
