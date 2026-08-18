import { describe, expect, test } from 'vitest';

import type { LessonContentDraft } from '../../src/services/lessonGenerationTypes.js';
import {
  buildApplicableLessonVerificationCheckIds,
  buildRequiredLessonVerificationCheckIds,
} from '../../src/services/lessonGenerationVerification.js';

const plainDraft: LessonContentDraft = {
  contentBlocks: [
    {
      markdown: '# Dall evento all azione\n\nUn evento fisico viene interpretato dal mapping.',
      type: 'markdown',
    },
  ],
  generatedVisuals: [],
  imageRefs: [],
};

const BASE_CHECKS = [
  'markdown-structure',
  'positive-definition',
  'self-sufficiency',
  'ascii-visual',
  'code-structure',
  'math-structure',
] as const;

describe('lesson verification prompt architecture', () => {
  test('keeps universal verifier invariants independent from optional draft features', () => {
    expect(buildApplicableLessonVerificationCheckIds(plainDraft)).toEqual(BASE_CHECKS);
  });

  test('requires report entries for semantic and structural checks', () => {
    const requiredIds = buildRequiredLessonVerificationCheckIds(
      { instructionPacks: [] },
      plainDraft
    );

    expect(requiredIds).toContain('core.progression');
    for (const checkId of BASE_CHECKS) expect(requiredIds).toContain(checkId);
    expect(new Set(requiredIds).size).toBe(requiredIds.length);
  });

  test('enables feature-scoped checks from structured draft features', () => {
    const imageDraft: LessonContentDraft = {
      ...plainDraft,
      imageRefs: [
        {
          alt: 'Schema del mapping',
          anchorHeading: 'Dall evento all azione',
          assetId: 'asset-1',
          caption: 'Dal segnale fisico all azione logica.',
        },
      ],
    };
    expect(buildApplicableLessonVerificationCheckIds(imageDraft)).toEqual([
      ...BASE_CHECKS,
      'image-reference',
    ]);

    const visualDraft: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        ...plainDraft.contentBlocks,
        { slotId: 'visual-1', type: 'generated-visual' },
      ],
      generatedVisuals: [
        {
          altText: 'Flusso dal dispositivo all azione',
          anchorHeading: 'Dall evento all azione',
          complexity: 'simple',
          concept: 'Mapping degli input',
          coverage: 'all_elements',
          coverageRationale: 'Mostra l intero flusso.',
          factualRequirements: ['Il dispositivo produce un evento', 'Il mapping assegna un azione'],
          interactionLevel: 'none',
          pedagogicalGoal: 'Rendere visibile la separazione tra evento e azione.',
          reason: 'La relazione e strutturale.',
          requiresDepiction: false,
          slotId: 'visual-1',
          title: 'Dal dispositivo all azione',
          visualDirection: 'Due box collegati da una freccia.',
          visualType: 'flowchart_svg',
        },
      ],
    };
    expect(buildApplicableLessonVerificationCheckIds(visualDraft)).toEqual([
      ...BASE_CHECKS,
      'generated-visual',
    ]);

    const youtubeDraft: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        ...plainDraft.contentBlocks,
        {
          clips: [{ endSeconds: 12, sourceIndex: 0, startSeconds: 4, title: 'Cambio di stato' }],
          type: 'youtube-clips',
        },
      ],
    };
    expect(buildApplicableLessonVerificationCheckIds(youtubeDraft)).toEqual([
      ...BASE_CHECKS,
      'youtube-structure',
    ]);

    const quizDraft: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        ...plainDraft.contentBlocks,
        {
          quiz: {
            correctIndex: 0,
            exerciseType: 'application-card',
            options: ['A', 'B', 'C', 'D'],
            question: 'Quale mapping useresti in un caso nuovo?',
          },
          type: 'inline-quiz',
        },
      ],
    };
    expect(buildApplicableLessonVerificationCheckIds(quizDraft)).toEqual([
      ...BASE_CHECKS,
      'quiz-quality',
      'quiz-text',
    ]);

    const requiredQuizIds = buildRequiredLessonVerificationCheckIds(
      { instructionPacks: [] },
      quizDraft
    );
    expect(requiredQuizIds).toContain('quiz-quality');
    expect(requiredQuizIds).toContain('quiz-text');
    expect(new Set(requiredQuizIds).size).toBe(requiredQuizIds.length);
  });
});
