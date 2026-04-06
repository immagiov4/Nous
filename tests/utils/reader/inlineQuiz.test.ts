import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildInlineQuizLayout } from '../../../utils/reader/inlineQuiz.ts';

test('buildInlineQuizLayout distributes questions across heading-based lesson chunks', () => {
  const layout = buildInlineQuizLayout(
    [
      '# Introduzione',
      '',
      'Panoramica iniziale.',
      '',
      '## Modello',
      '',
      'Spiegazione del modello.',
      '',
      '## Pipeline',
      '',
      'Spiegazione della pipeline.',
      '',
      '## Errori comuni',
      '',
      'Spiegazione degli errori comuni.',
    ].join('\n'),
    5
  );

  assert.equal(layout.length, 4);
  assert.deepEqual(
    layout.map(chunk => chunk.questionIndexes),
    [[0], [1], [2, 3], [4]]
  );
});

test('buildInlineQuizLayout falls back to paragraph grouping when headings are too sparse', () => {
  const layout = buildInlineQuizLayout(
    ['Paragrafo 1.', '', 'Paragrafo 2.', '', 'Paragrafo 3.', '', 'Paragrafo 4.'].join('\n'),
    2
  );

  assert.equal(layout.length, 2);
  assert.match(layout[0]?.markdown || '', /Paragrafo 1/);
  assert.match(layout[1]?.markdown || '', /Paragrafo 4/);
  assert.deepEqual(
    layout.map(chunk => chunk.questionIndexes),
    [[0], [1]]
  );
});
