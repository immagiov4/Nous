import assert from 'node:assert/strict';
import { expect, test } from 'vitest';

import {
  buildConversationNoteSaveCandidates,
  hasAnchorableConversationNoteCandidate,
} from '../../../utils/context/conversationNote.ts';
import { resolveSelectedSegments } from '../../../utils/learning/sectionAnnotationProjection.ts';
import { buildVisibleProjection } from '../../../utils/markdown/textProjection.ts';

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

  expect(hasAnchorableConversationNoteCandidate(content, { selectedText: 'Testo assente' })).toBe(
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

test('anchors rendered link text after nested unclosed fence openers', () => {
  const content = ['```ts', '```js', '[Docs](https://example.com)'].join('\n');

  expect(hasAnchorableConversationNoteCandidate(content, { selectedText: 'Docs' })).toBe(true);
  assert.equal(
    hasAnchorableConversationNoteCandidate(content, { selectedText: 'https://example.com' }),
    false
  );
});

test('anchors rendered link text after raw HTML reveals an unclosed fence', () => {
  const content = ['<div>', '```ts', 'code', '</div>', '## After [Docs](https://e.test)'].join(
    '\n'
  );

  expect(hasAnchorableConversationNoteCandidate(content, { selectedText: 'Docs' })).toBe(true);
  assert.equal(
    hasAnchorableConversationNoteCandidate(content, { selectedText: 'https://e.test' }),
    false
  );
});

test('anchors visible text after a lone-CR line boundary', () => {
  assert.equal(
    hasAnchorableConversationNoteCandidate('Prima\rDopo', { selectedText: 'Dopo' }),
    true
  );
});

test.each([
  ['PDF image', '{{PDF_IMAGE:asset-1|alt=Schema durevole}}', 'Schema durevole'],
  ['visual example', '{{VISUAL_EXAMPLE:visual-1|title=Schema durevole}}', 'Schema durevole'],
  ['YouTube clip', '{{YOUTUBE_CLIP_SOURCE:1|START:10|END:20}}', 'START'],
  ['inline quiz', '{{INLINE_QUIZ:1}}', '1'],
  ['visual slot', '{{VISUAL_SLOT:slot-1|title=Schema durevole}}', 'Schema durevole'],
] as const)('rejects note proposals whose text exists only in an unsupported viewer placeholder: %s', (_placeholderType, content, selectedText) => {
  expect(hasAnchorableConversationNoteCandidate(content, { selectedText })).toBe(false);
});

test('accepts note proposals inside malformed placeholder-like text shown by the reader', () => {
  expect(
    hasAnchorableConversationNoteCandidate('{{PDF_IMAGE:asset-1|foo=bar}}', {
      selectedText: 'foo=bar',
    })
  ).toBe(true);
});

test('rejects candidates that resolve only a visible fragment around protected text', () => {
  expect(
    hasAnchorableConversationNoteCandidate(
      'Testo [fonte](https://example.com/percorso-nascosto) conclusivo.',
      { selectedText: 'Testo percorso nascosto conclusivo' }
    )
  ).toBe(false);
});

test('rejects note proposals that would insert markup inside an autolink', () => {
  expect(
    hasAnchorableConversationNoteCandidate('Consulta <https://example.com> per i dettagli.', {
      selectedText: 'https://example.com',
    })
  ).toBe(false);
  assert.equal(
    hasAnchorableConversationNoteCandidate('Scrivi a <reader@example.com>.', {
      selectedText: 'reader@example.com',
    }),
    false
  );
});

test('accepts complete candidates through loose case and accent normalization', () => {
  expect(
    hasAnchorableConversationNoteCandidate('Il Caffè resume il concetto.', {
      selectedText: 'CAFFE RESUME',
    })
  ).toBe(true);
});

test('keeps meaningful operators when validating the complete anchor text', () => {
  expect(
    hasAnchorableConversationNoteCandidate('Formula A/B valida', { selectedText: 'A+B' })
  ).toBe(false);
  assert.equal(
    hasAnchorableConversationNoteCandidate('La cache – non il database', {
      selectedText: 'La cache - non il database',
    }),
    true
  );
});

test('rejects task-list checkbox syntax as an annotation anchor', () => {
  expect(hasAnchorableConversationNoteCandidate('- [x] Completato', { selectedText: 'x' })).toBe(
    false
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate('- [ ] Da completare', {
      selectedText: 'Da completare',
    }),
    true
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate('1. [X] Completato', { selectedText: 'X' }),
    false
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate('- [x]\n  Continuazione', { selectedText: 'x' }),
    false
  );
});

test('accepts anchors in bare code-like text that the renderer leaves as prose', () => {
  const content = 'Spiegazione.\n\ncpp while (i < 5) { std::cout << i; }';

  expect(hasAnchorableConversationNoteCandidate(content, { selectedText: 'while' })).toBe(true);
});

test('keeps malformed JSON and its unmatched fence visible to note projection', () => {
  const content = [
    'Dati della sessione:',
    '',
    '{ "userId": 42, "role": "admin" }',
    '```',
    '',
    'Il ruolo resta visibile nella spiegazione.',
  ].join('\n');

  expect(hasAnchorableConversationNoteCandidate(content, { selectedText: 'admin' })).toBe(true);
  assert.equal(
    hasAnchorableConversationNoteCandidate(content, {
      selectedText: 'ruolo resta visibile',
    }),
    true
  );
});

test('accepts rendered Markdown character references as anchorable text', () => {
  expect(
    hasAnchorableConversationNoteCandidate('Prima A &amp; B dopo.', {
      selectedText: 'A & B',
    })
  ).toBe(true);
  assert.equal(
    hasAnchorableConversationNoteCandidate('<mark>\nA &amp; B\n</mark>', {
      selectedText: 'A & B',
    }),
    true
  );
  assert.equal(
    hasAnchorableConversationNoteCandidate('<div>\nA &amp; B\n</div>', {
      selectedText: 'A & B',
    }),
    true
  );
});

test('rejects anchors inside hidden HTML nested in escaped raw HTML', () => {
  expect(
    hasAnchorableConversationNoteCandidate('<script>\n\n<!-- internal -->\n\n</script>', {
      selectedText: 'internal',
    })
  ).toBe(false);
});

test('rejects text rendered from renderer-normalized bare math', () => {
  expect(
    hasAnchorableConversationNoteCandidate(String.raw`Prima (\text{velocity}) dopo.`, {
      selectedText: 'velocity',
    })
  ).toBe(false);
});

test('keeps visible prose beside delimited inline math anchorable', () => {
  expect(
    hasAnchorableConversationNoteCandidate(String.raw`x = $\frac{a}{b}$`, {
      selectedText: 'x =',
    })
  ).toBe(true);
});

test('accepts complete candidates through KaTeX selection normalization', () => {
  expect(
    hasAnchorableConversationNoteCandidate('Ridurre soprattutto $T_{\\text{cluster}}$ accelera.', {
      selectedText: 'Ridurre soprattutto TclusterT_{\\text{cluster}}Tcluster accelera.',
    })
  ).toBe(true);
});

test('rejects candidates found only in a reference definition', () => {
  expect(
    hasAnchorableConversationNoteCandidate(
      '![Schema][schema]\n\n[schema]: https://example.com/percorso-nascosto',
      { selectedText: 'percorso nascosto' }
    )
  ).toBe(false);
});

test('rejects candidates found only in a multiline reference definition title', () => {
  expect(
    hasAnchorableConversationNoteCandidate('[ref]: /image.png\n  "Titolo nascosto"', {
      selectedText: 'Titolo nascosto',
    })
  ).toBe(false);
});

test('rejects candidates that name non-text Markdown block syntax', () => {
  expect(hasAnchorableConversationNoteCandidate('---', { selectedText: '---' })).toBe(false);
  assert.equal(
    hasAnchorableConversationNoteCandidate('| Header |\n| --- |\n| Value |', {
      selectedText: '| --- |',
    }),
    false
  );
});

test('distinguishes visible footnote content from nested fenced code', () => {
  expect(
    hasAnchorableConversationNoteCandidate('Testo[^nota]\n\n[^nota]: Contenuto visibile', {
      selectedText: 'Contenuto visibile',
    })
  ).toBe(true);
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
  expect(
    hasAnchorableConversationNoteCandidate('    Frase visibile normalizzata.', {
      selectedText: 'Frase visibile normalizzata',
    })
  ).toBe(true);
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
  assert.equal(
    hasAnchorableConversationNoteCandidate('<div>\n$x$\n</div>', {
      selectedText: 'x',
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

  expect(candidates[0]).toStrictEqual({
    fallbackSelection: {
      contextAfter: 'contesto vecchio dopo',
      contextBefore: 'contesto vecchio prima',
      selectedText: 'passaggio originale',
      selectedTextStart: 10,
    },
    note: 'Nota',
    selectedText: 'passaggio raffinato',
    selectedTextStart: 10,
  });
});

test('keeps a refined repeated phrase at the original occurrence', () => {
  const content =
    'Il concetto chiave compare qui. Poi il concetto chiave esteso compare nel punto scelto.';
  const selectedTextStart = content.indexOf('concetto chiave esteso');
  const candidate = buildConversationNoteSaveCandidates({
    anchor: {
      selectedText: 'concetto chiave esteso',
      selectedTextStart,
    },
    toolInput: {
      note: 'Nota',
      selectedText: 'concetto chiave',
    },
  })[0];

  assert.ok(candidate);
  expect(candidate.selectedTextStart).toBe(selectedTextStart);
  assert.equal(hasAnchorableConversationNoteCandidate(content, candidate), true);
  assert.deepEqual(resolveSelectedSegments({ content, ...candidate }), [
    { start: selectedTextStart, end: selectedTextStart + 'concetto chiave'.length },
  ]);
});

test('uses the original occurrence for a refined repeated word', () => {
  const content =
    '# Introduzione\n\nIl termine compare qui. Poi il termine esteso compare nel punto scelto.';
  const sourceStart = content.indexOf('termine esteso');
  const selectedTextStart = buildVisibleProjection(content).text.indexOf('termine esteso');
  const candidate = buildConversationNoteSaveCandidates({
    anchor: { selectedText: 'termine esteso', selectedTextStart },
    toolInput: { note: 'Nota', selectedText: 'termine' },
  })[0];

  assert.ok(candidate);
  expect(resolveSelectedSegments({ content, ...candidate })).toStrictEqual([
    { start: sourceStart, end: sourceStart + 'termine'.length },
  ]);
});

test('keeps a refined inner word inside the original selection', () => {
  const content = 'Il concetto compare qui. Poi il concetto chiave compare nel punto scelto.';
  const selectedTextStart = content.indexOf('il concetto chiave');
  const candidate = buildConversationNoteSaveCandidates({
    anchor: { selectedText: 'il concetto chiave', selectedTextStart },
    toolInput: { note: 'Nota', selectedText: 'concetto' },
  })[0];

  assert.ok(candidate);
  expect(hasAnchorableConversationNoteCandidate(content, candidate)).toBe(true);
  assert.deepEqual(
    resolveSelectedSegments({
      content,
      ...candidate,
      preferredSelection: candidate.fallbackSelection,
    }),
    [{ start: selectedTextStart + 3, end: selectedTextStart + 3 + 'concetto'.length }]
  );
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
      selectedTextStart: 128,
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
