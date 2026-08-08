import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  deriveQuizFromLessonContentBlocks,
  hasValidTypedQuizBlocks,
  legacyMarkdownToLessonContentBlocks,
  materializeGeneratedVisualBlocks,
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

test('persists failed visual plans and maps partial success by slot id', () => {
  const plans = [
    {
      slotId: 'slot-001',
      complexity: 'simple' as const,
      concept: 'Primo concetto',
      coverage: 'single_complex' as const,
      coverageRationale: 'Mostra il primo concetto.',
      factualRequirements: ['Requisito uno'],
      interactionLevel: 'none' as const,
      pedagogicalGoal: 'Chiarire il primo concetto.',
      reason: 'Serve un esempio.',
      requiresDepiction: false,
      visualDirection: 'Schema semplice.',
      visualType: 'structural_svg' as const,
    },
    {
      slotId: 'slot-002',
      complexity: 'moderate' as const,
      concept: 'Secondo concetto',
      coverage: 'all_elements' as const,
      coverageRationale: 'Mostra tutti gli elementi.',
      factualRequirements: ['Requisito due'],
      interactionLevel: 'low' as const,
      pedagogicalGoal: 'Chiarire il secondo concetto.',
      reason: 'Serve il confronto.',
      requiresDepiction: true,
      visualDirection: 'Confronto affiancato.',
      visualType: 'illustrative_image' as const,
    },
  ];
  const visual = {
    code: 'data:image/png;base64,AAAA',
    createdAt: '2026-07-26T00:00:00.000Z',
    id: 'visual-002',
    kind: 'image' as const,
    title: 'Secondo concetto',
  };

  const blocks = materializeGeneratedVisualBlocks(
    [
      { slotId: 'slot-001', type: 'generated-visual' },
      { slotId: 'slot-002', type: 'generated-visual' },
    ],
    plans,
    [{ slotId: 'slot-002', visual }]
  );

  assert.deepEqual(blocks, [
    { retryPlan: plans[0], slotId: 'slot-001', type: 'generated-visual' },
    { slotId: 'slot-002', type: 'generated-visual', visualId: 'visual-002' },
  ]);
  assert.deepEqual(normalizeLessonContentBlocks(blocks), blocks);
});
