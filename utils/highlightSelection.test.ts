import { test } from 'vitest';
import assert from 'node:assert/strict';
import { toggleHighlightInContent } from './highlightSelection.ts';

test('highlights punctuation-only selection at the exact contextual occurrence', () => {
  const content = 'Uno (Client ). Due esplosa (un errore ).';
  const updated = toggleHighlightInContent({
    content,
    selectedText: ').',
    contextBefore: 'esplosa (un errore',
    contextAfter: '',
  });

  assert.equal(updated, 'Uno (Client ). Due esplosa (un errore <mark>).</mark>');
});

test('falls back to exact punctuation match when only one occurrence exists', () => {
  const content = 'La promessa esplosa (un errore ).';
  const updated = toggleHighlightInContent({
    content,
    selectedText: ').',
  });

  assert.equal(updated, 'La promessa esplosa (un errore <mark>).</mark>');
});

test('keeps fuzzy highlighting for partial word selections', () => {
  const content = 'Questo problema richiede attenzione.';
  const updated = toggleHighlightInContent({
    content,
    selectedText: 'roble',
  });

  assert.equal(updated, 'Questo <mark>problema</mark> richiede attenzione.');
});

test('highlights selections containing a colon without swallowing markdown emphasis', () => {
  const content = '**Termine:** definizione importante.';
  const updated = toggleHighlightInContent({
    content,
    selectedText: 'Termine: definizione',
    contextAfter: ' importante.',
  });

  assert.equal(updated, '**<mark>Termine:</mark>** <mark>definizione</mark> importante.');
});

test('toggles colon selections across markdown emphasis cleanly', () => {
  const content = '**Termine:** definizione importante.';
  const highlighted = toggleHighlightInContent({
    content,
    selectedText: 'Termine: definizione',
    contextAfter: ' importante.',
  });

  assert.equal(highlighted, '**<mark>Termine:</mark>** <mark>definizione</mark> importante.');

  const unhighlighted = toggleHighlightInContent({
    content: highlighted || '',
    selectedText: 'Termine: definizione',
    contextAfter: ' importante.',
  });

  assert.equal(unhighlighted, content);
});

test('does not inject mark tags inside inline code spans', () => {
  const content = 'Classe cardine: `Server`.';
  const updated = toggleHighlightInContent({
    content,
    selectedText: 'Server',
  });

  assert.equal(updated, null);
});

test('matches long selections that cross inline code identifiers with underscores', () => {
  const content = 'Se vedo `get_node_block_pos`, capisco meglio.';
  const updated = toggleHighlightInContent({
    content,
    selectedText: 'Se vedo get_node_block_pos, capisco meglio.',
  });

  assert.equal(updated, '<mark>Se vedo</mark> `get_node_block_pos`<mark>, capisco meglio.</mark>');
});

test('splits multi-paragraph highlights so each paragraph start stays marked', () => {
  const content =
    'Primo paragrafo con `const` e chiusura.\n\nSecondo inizio normale prima di `foo_bar` e conclusione.';
  const updated = toggleHighlightInContent({
    content,
    selectedText:
      'Primo paragrafo con const e chiusura.\n\nSecondo inizio normale prima di foo_bar e conclusione.',
  });

  assert.equal(
    updated,
    '<mark>Primo paragrafo con</mark> `const` <mark>e chiusura.</mark>\n\n<mark>Secondo inizio normale prima di</mark> `foo_bar` <mark>e conclusione.</mark>'
  );
});

test('falls back to loose normalized matching for accented and punctuated prose', () => {
  const content = 'I nomi devono essere in snake_case, e ogni file deve includere tutto cio da cui dipende.';
  const updated = toggleHighlightInContent({
    content,
    selectedText: 'I nomi devono essere in snake_case, e ogni file deve includere tutto ciò da cui dipende.',
  });

  assert.equal(
    updated,
    '<mark>I nomi devono essere in snake_case,</mark> <mark>e ogni file deve includere tutto cio da cui dipende</mark>.'
  );
});

test('does not inject mark tags inside fenced code blocks', () => {
  const content = 'Esempio:\n\n```cpp\nServer server;\n```';
  const updated = toggleHighlightInContent({
    content,
    selectedText: 'Server',
  });

  assert.equal(updated, null);
});
