import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildVisibleProjection,
  trimSegmentWhitespace,
} from '../../../utils/markdown/textProjection.ts';

test('buildVisibleProjection skips closing parentheses inside quoted link titles', () => {
  const projection = buildVisibleProjection(
    'Prima [un link](https://example.com "Titolo con ) parentesi") dopo.'
  );

  assert.equal(projection.text, 'Prima un link dopo.');
});

test('trimSegmentWhitespace trims source ranges without changing inner text', () => {
  const content = 'Intro\n\n  testo da segnare\t\n\nFine';
  const segment = trimSegmentWhitespace(content, { start: 7, end: 27 });

  assert.deepEqual(segment, { start: 9, end: 25 });
  assert.equal(segment ? content.slice(segment.start, segment.end) : '', 'testo da segnare');
});

test('trimSegmentWhitespace returns null for whitespace-only ranges', () => {
  assert.equal(trimSegmentWhitespace('A\n \t\nB', { start: 1, end: 5 }), null);
});
