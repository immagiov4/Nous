import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildInlineQuizLayout } from '../../../utils/reader/inlineQuiz.ts';

test('buildInlineQuizLayout puts legacy unanchored questions after the lesson', () => {
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

  assert.equal(layout.length, 1);
  assert.deepEqual(
    layout.map(chunk => chunk.questionIndexes),
    [[0, 1, 2, 3, 4]]
  );
});

test('buildInlineQuizLayout keeps unanchored questions after all paragraphs', () => {
  const layout = buildInlineQuizLayout(
    ['Paragrafo 1.', '', 'Paragrafo 2.', '', 'Paragrafo 3.', '', 'Paragrafo 4.'].join('\n'),
    2
  );

  assert.equal(layout.length, 1);
  assert.match(layout[0]?.markdown || '', /Paragrafo 1/);
  assert.match(layout[0]?.markdown || '', /Paragrafo 4/);
  assert.deepEqual(
    layout.map(chunk => chunk.questionIndexes),
    [[0, 1]]
  );
});

test('buildInlineQuizLayout honors the model-selected exact paragraph anchor', () => {
  const layout = buildInlineQuizLayout(
    [
      '## Prima sezione',
      '',
      'Premessa che non basta per rispondere.',
      '',
      '## Seconda sezione',
      '',
      'Ora sono disponibili entrambi gli elementi del confronto.',
    ].join('\n'),
    [
      {
        anchorExcerpt: 'entrambi gli elementi del confronto',
        correctIndex: 0,
        options: ['A', 'B', 'C', 'D'],
        question: 'Confronta i due elementi.',
      },
    ]
  );

  assert.deepEqual(
    layout.map(chunk => chunk.questionIndexes),
    [[0]]
  );
});
