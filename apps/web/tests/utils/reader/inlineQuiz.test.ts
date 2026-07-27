import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { QuizQuestion } from '../../../types.ts';
import {
  buildInlineQuizLayout,
  hasExactInlineQuizMarkerContract,
} from '../../../utils/reader/inlineQuiz.ts';

const questions: QuizQuestion[] = [
  {
    correctIndex: 0,
    options: ['A', 'B', 'C', 'D'],
    question: 'Applica il primo concetto.',
  },
  {
    correctIndex: 1,
    options: ['A', 'B', 'C', 'D'],
    question: 'Confronta i due concetti.',
  },
];

test('buildInlineQuizLayout preserves the author-selected inline marker positions', () => {
  const layout = buildInlineQuizLayout(
    [
      '## Primo concetto',
      '',
      'La spiegazione rende risolvibile la prima pausa.',
      '',
      '{{INLINE_QUIZ:0}}',
      '',
      '## Secondo concetto',
      '',
      'Ora il confronto ha tutti gli elementi necessari.',
      '',
      '{{INLINE_QUIZ:1}}',
      '',
      'Conclusione della lezione.',
    ].join('\n'),
    questions
  );

  assert.deepEqual(
    layout.map(chunk => chunk.questionIndexes),
    [[0], [1], []]
  );
  assert.match(layout[0]?.markdown || '', /prima pausa/);
  assert.match(layout[1]?.markdown || '', /tutti gli elementi necessari/);
  assert.match(layout[2]?.markdown || '', /Conclusione/);
});

test('inline quiz markers must cover every question once and in array order', () => {
  assert.equal(
    hasExactInlineQuizMarkerContract('Prima.\n\n{{INLINE_QUIZ:0}}\n\nSeconda.', 2),
    false
  );
  assert.equal(
    hasExactInlineQuizMarkerContract(
      'Prima.\n\n{{INLINE_QUIZ:1}}\n\nSeconda.\n\n{{INLINE_QUIZ:0}}',
      2
    ),
    false
  );
});

test('inline quiz markers cannot be clustered without lesson text between them', () => {
  assert.throws(
    () =>
      buildInlineQuizLayout(
        'Lezione completa.\n\n{{INLINE_QUIZ:0}}\n\n{{INLINE_QUIZ:1}}',
        questions
      ),
    /Invalid inline quiz marker contract/
  );
});

test('inline quiz marker contract rejects malformed reserved tokens beside valid markers', () => {
  const malformedContents = [
    'Prima.\n\n{{INLINE_QUIZ:0}}\n\nSeconda.\n\n{{INLINE_QUIZ:errore}}',
    'Prima.\n\n{{INLINE_QUIZ:0}}\n\nSeconda.\n\n{{INLINE_QUIZ:',
    'Prima.\n\n{{INLINE_QUIZ:0}}\n\nSeconda.\n\n{{INLINE_QUIZ}}',
  ];

  for (const content of malformedContents) {
    assert.equal(hasExactInlineQuizMarkerContract(content, 1), false);
    assert.throws(
      () => buildInlineQuizLayout(content, questions.slice(0, 1)),
      /Invalid inline quiz marker contract/
    );
  }
});

test('inline quiz markers inside Markdown code are literal content, not structural markers', () => {
  const content = [
    'La sintassi del marker puo essere citata come `{{INLINE_QUIZ:0}}`.',
    '',
    '```text',
    '{{INLINE_QUIZ:errore}}',
    '```',
    '',
    'La lezione legacy continua normalmente.',
  ].join('\n');

  assert.equal(hasExactInlineQuizMarkerContract(content, 1), false);
  assert.deepEqual(buildInlineQuizLayout(content, questions.slice(0, 1)), [
    { markdown: content, questionIndexes: [0] },
  ]);
});

test('only standalone unprotected inline quiz markers satisfy the structural contract', () => {
  const content = [
    'Esempio letterale: `{{INLINE_QUIZ:0}}`.',
    '',
    'Spiegazione sufficiente per la pausa.',
    '',
    '{{INLINE_QUIZ:0}}',
    '',
    'Conclusione.',
  ].join('\n');
  const layout = buildInlineQuizLayout(content, questions.slice(0, 1));

  assert.equal(hasExactInlineQuizMarkerContract(content, 1), true);
  assert.equal(layout.length, 2);
  assert.match(layout[0]?.markdown || '', /`\{\{INLINE_QUIZ:0}}`/);
  assert.deepEqual(
    layout.map(chunk => chunk.questionIndexes),
    [[0], []]
  );
  assert.equal(
    hasExactInlineQuizMarkerContract('Testo {{INLINE_QUIZ:0}} nella stessa riga.', 1),
    false
  );
  assert.throws(
    () =>
      buildInlineQuizLayout('Testo {{INLINE_QUIZ:0}} nella stessa riga.', questions.slice(0, 1)),
    /Invalid inline quiz marker contract/
  );
});

test('legacy lessons may mention INLINE_QUIZ without opening reserved marker syntax', () => {
  const content = 'La stringa INLINE_QUIZ identifica internamente il tipo di pausa.';

  assert.deepEqual(buildInlineQuizLayout(content, questions.slice(0, 1)), [
    { markdown: content, questionIndexes: [0] },
  ]);
});

test('legacy exact anchors remain readable without affecting the new marker contract', () => {
  const legacyQuestions: QuizQuestion[] = [
    { ...questions[0], anchorExcerpt: 'prima spiegazione' },
    { ...questions[1], anchorExcerpt: 'seconda spiegazione' },
  ];
  const layout = buildInlineQuizLayout(
    'La prima spiegazione rende risolvibile la pausa.\n\nLa seconda spiegazione completa il confronto.\n\nConclusione.',
    legacyQuestions
  );

  assert.deepEqual(
    layout.map(chunk => chunk.questionIndexes),
    [[0], [1], []]
  );
});

test('legacy unanchored questions keep their explicit end-of-lesson fallback', () => {
  const layout = buildInlineQuizLayout('Lezione persistita senza marker.', questions);

  assert.deepEqual(layout, [
    {
      markdown: 'Lezione persistita senza marker.',
      questionIndexes: [0, 1],
    },
  ]);
});
