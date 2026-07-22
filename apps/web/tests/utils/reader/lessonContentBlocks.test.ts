import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  deriveQuizFromLessonContentBlocks,
  hasValidTypedQuizBlocks,
  legacyMarkdownToLessonContentBlocks,
  normalizeLessonContentBlocks,
} from '../../../utils/reader/lessonContentBlocks.ts';

const quiz = {
  correctIndex: 1,
  exerciseType: 'application-card' as const,
  options: ['A', 'B', 'C', 'D'],
  question: 'Quale trasformazione viene applicata per prima?',
};

test('keeps inline quizzes self-contained and validates their ordered placement', () => {
  const blocks = normalizeLessonContentBlocks([
    { type: 'markdown', markdown: '## Rotazioni\n\nApplica prima la rotazione locale.' },
    { type: 'inline-quiz', quiz },
    {
      type: 'youtube-clips',
      clips: [
        { sourceIndex: 0, startSeconds: 20, endSeconds: 45, title: 'Rotazione locale' },
        { sourceIndex: 0, startSeconds: 60, endSeconds: 75, title: 'Composizione globale' },
      ],
    },
  ]);

  assert.equal(hasValidTypedQuizBlocks(blocks, { exact: 1 }), true);
  assert.deepEqual(deriveQuizFromLessonContentBlocks(blocks), [quiz]);
  assert.deepEqual(blocks[2], {
    type: 'youtube-clips',
    clips: [
      { sourceIndex: 0, startSeconds: 20, endSeconds: 45, title: 'Rotazione locale' },
      { sourceIndex: 0, startSeconds: 60, endSeconds: 75, title: 'Composizione globale' },
    ],
  });
});

test('accepts an inline quiz after another pedagogical block', () => {
  const blocks = normalizeLessonContentBlocks([
    { type: 'markdown', markdown: '## Rotazioni\n\nOsserva la trasformazione.' },
    {
      type: 'youtube-clips',
      clips: [{ sourceIndex: 0, startSeconds: 20, endSeconds: 45, title: 'Rotazione locale' }],
    },
    { type: 'inline-quiz', quiz },
  ]);

  assert.equal(hasValidTypedQuizBlocks(blocks, { exact: 1 }), true);
});

test('rejects inline quizzes without preceding content or immediately after another quiz', () => {
  assert.equal(
    hasValidTypedQuizBlocks(
      [
        { type: 'inline-quiz', quiz },
        { type: 'markdown', markdown: 'Contenuto successivo.' },
      ],
      { exact: 1 }
    ),
    false
  );
  assert.equal(
    hasValidTypedQuizBlocks(
      [
        { type: 'markdown', markdown: 'Contenuto preparatorio.' },
        { type: 'inline-quiz', quiz },
        { type: 'inline-quiz', quiz },
      ],
      { exact: 2 }
    ),
    false
  );
});

test('normalizes legacy markers only when loading old content', () => {
  const blocks = legacyMarkdownToLessonContentBlocks(
    'Spiegazione.\n\n{{INLINE_QUIZ:0}}\n\nConclusione.',
    [quiz]
  );

  assert.deepEqual(blocks, [
    { type: 'markdown', markdown: 'Spiegazione.' },
    { type: 'inline-quiz', quiz },
    { type: 'markdown', markdown: 'Conclusione.' },
  ]);
});
