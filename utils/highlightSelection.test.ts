import test from 'node:test';
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
