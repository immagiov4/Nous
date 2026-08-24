import { describe, expect, test } from 'vitest';

import type { LessonContentDraft } from '../../src/services/lessonGenerationTypes.js';
import {
  buildApplicableLessonVerificationCheckIds,
  buildRequiredLessonVerificationCheckIds,
  findUncheckedLessonVerificationStructuralCheckIds,
  isLessonVerificationReportComplete,
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
  'quiz-quality',
  'generated-visual',
] as const;

const EMPTY_CHECK_CONTEXT = {
  imageCandidates: [],
  instructionPacks: [],
  sources: [],
} as const;

const imageCandidate = {
  caption: 'Schema originale del mapping.',
  id: 'asset-1',
  sourceOrder: 0,
  textCurrent: 'Il diagramma mostra il passaggio dall evento fisico all azione logica.',
  visibleLabel: 'Figura 1',
};

const timestampedYoutubeSource = {
  title: 'Dimostrazione del cambio di stato',
  url: 'https://www.youtube.com/watch?v=demo',
  youtubeTranscript: {
    segments: [
      {
        endSeconds: 8,
        startSeconds: 0,
        text: 'Il dispositivo cambia stato durante la dimostrazione.',
      },
    ],
  },
};

const imageRef = {
  alt: 'Schema del mapping',
  anchorHeading: 'Dall evento all azione',
  assetId: 'asset-1',
  caption: 'Dal segnale fisico all azione logica.',
};

const generatedVisual = {
  altText: 'Flusso dal dispositivo all azione',
  anchorHeading: 'Dall evento all azione',
  complexity: 'simple' as const,
  concept: 'Mapping degli input',
  coverage: 'all_elements' as const,
  coverageRationale: 'Mostra l intero flusso.',
  factualRequirements: ['Il dispositivo produce un evento', 'Il mapping assegna un azione'],
  interactionLevel: 'none' as const,
  pedagogicalGoal: 'Rendere visibile la separazione tra evento e azione.',
  reason: 'La relazione e strutturale.',
  requiresDepiction: false,
  slotId: 'visual-1',
  title: 'Dal dispositivo all azione',
  visualDirection: 'Due box collegati da una freccia.',
  visualType: 'flowchart_svg' as const,
};

const inlineQuizBlock = {
  quiz: {
    correctIndex: 0,
    exerciseType: 'application-card',
    options: ['A', 'B', 'C', 'D'],
    question: 'Quale mapping useresti in un caso nuovo?',
  },
  type: 'inline-quiz' as const,
};

describe('lesson verification prompt architecture', () => {
  test('keeps base verifier invariants independent from draft-owned optional media', () => {
    expect(buildApplicableLessonVerificationCheckIds(plainDraft)).toEqual(BASE_CHECKS);
  });

  test('keeps omission-repair checks available for required pauses and generated visuals', () => {
    const requiredIds = buildRequiredLessonVerificationCheckIds(EMPTY_CHECK_CONTEXT, plainDraft);

    expect(requiredIds).toContain('quiz-quality');
    expect(requiredIds).toContain('generated-visual');
  });

  test('scopes code and math structural checks to their instruction packs', () => {
    const plainIds = buildRequiredLessonVerificationCheckIds(EMPTY_CHECK_CONTEXT, plainDraft);
    const codeIds = buildRequiredLessonVerificationCheckIds(
      { ...EMPTY_CHECK_CONTEXT, instructionPacks: ['code'] },
      plainDraft
    );
    const mathIds = buildRequiredLessonVerificationCheckIds(
      { ...EMPTY_CHECK_CONTEXT, instructionPacks: ['mathematics'] },
      plainDraft
    );

    expect(plainIds).not.toContain('code-structure');
    expect(plainIds).not.toContain('math-structure');
    expect(codeIds).toContain('code-structure');
    expect(codeIds).not.toContain('math-structure');
    expect(mathIds).toContain('math-structure');
    expect(mathIds).not.toContain('code-structure');
  });

  test('requires report entries for semantic coverage and structural checks', () => {
    const requiredIds = buildRequiredLessonVerificationCheckIds(EMPTY_CHECK_CONTEXT, plainDraft);

    expect(requiredIds).toContain('core.coverage');
    expect(requiredIds).toContain('core.progression');
    for (const checkId of BASE_CHECKS) expect(requiredIds).toContain(checkId);
    expect(new Set(requiredIds).size).toBe(requiredIds.length);
  });

  test('requires concrete evidence while preserving exact check-id coverage', () => {
    const checkIds = ['core.progression', 'markdown-structure'];
    const completeReport = [
      { checkId: 'core.progression', evidence: 'La bozza introduce il mapping dopo l evento.' },
      {
        checkId: 'markdown-structure',
        evidence: 'I blocchi markdown non contengono marker o bibliografie.',
      },
    ];

    expect(isLessonVerificationReportComplete(completeReport, checkIds)).toBe(true);
    expect(
      isLessonVerificationReportComplete(
        [completeReport[0], { checkId: 'markdown-structure', evidence: '' }],
        checkIds
      )
    ).toBe(false);
    expect(
      isLessonVerificationReportComplete(
        [completeReport[0], { checkId: 'markdown-structure', evidence: '   ' }],
        checkIds
      )
    ).toBe(false);
    expect(isLessonVerificationReportComplete([completeReport[0]], checkIds)).toBe(false);
    expect(
      isLessonVerificationReportComplete(
        [completeReport[0], { checkId: 'core.progression', evidence: 'Duplicato.' }],
        checkIds
      )
    ).toBe(false);
  });

  test('adds source-driven checks before the corresponding media exists', () => {
    const imageIds = buildRequiredLessonVerificationCheckIds(
      { ...EMPTY_CHECK_CONTEXT, imageCandidates: [imageCandidate] },
      plainDraft
    );
    const youtubeIds = buildRequiredLessonVerificationCheckIds(
      { ...EMPTY_CHECK_CONTEXT, sources: [timestampedYoutubeSource] },
      plainDraft
    );

    expect(imageIds).toContain('image-reference');
    expect(youtubeIds).toContain('youtube-structure');
  });

  test('adds draft-owned image and YouTube checks without changing always-available checks', () => {
    const imageDraft: LessonContentDraft = { ...plainDraft, imageRefs: [imageRef] };
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
      generatedVisuals: [generatedVisual],
    };
    expect(buildApplicableLessonVerificationCheckIds(visualDraft)).toEqual(BASE_CHECKS);

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
      contentBlocks: [...plainDraft.contentBlocks, inlineQuizBlock],
    };
    expect(buildApplicableLessonVerificationCheckIds(quizDraft)).toEqual(BASE_CHECKS);
  });

  test('blocks source-dependent media introduced without source authorization', () => {
    const checkedIds = buildRequiredLessonVerificationCheckIds(EMPTY_CHECK_CONTEXT, plainDraft);
    const verifiedWithNewYoutube: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        ...plainDraft.contentBlocks,
        {
          clips: [{ endSeconds: 12, sourceIndex: 0, startSeconds: 4, title: 'Cambio di stato' }],
          type: 'youtube-clips',
        },
      ],
    };
    const verifiedWithNewImageRef: LessonContentDraft = {
      ...plainDraft,
      imageRefs: [imageRef],
    };

    expect(
      findUncheckedLessonVerificationStructuralCheckIds(
        { imageCandidates: [], instructionPacks: [], sources: [] },
        verifiedWithNewYoutube,
        checkedIds
      )
    ).toEqual(['youtube-structure']);
    expect(
      findUncheckedLessonVerificationStructuralCheckIds(
        { imageCandidates: [], instructionPacks: [], sources: [] },
        verifiedWithNewImageRef,
        checkedIds
      )
    ).toEqual(['image-reference']);
  });

  test('allows source-dependent media introduced under the corresponding source check', () => {
    const imageContext = { imageCandidates: [imageCandidate], instructionPacks: [], sources: [] };
    const imageCheckedIds = buildRequiredLessonVerificationCheckIds(imageContext, plainDraft);
    const verifiedWithImageRef: LessonContentDraft = { ...plainDraft, imageRefs: [imageRef] };

    const youtubeContext = {
      imageCandidates: [],
      instructionPacks: [],
      sources: [timestampedYoutubeSource],
    };
    const youtubeCheckedIds = buildRequiredLessonVerificationCheckIds(youtubeContext, plainDraft);
    const verifiedWithYoutube: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        ...plainDraft.contentBlocks,
        {
          clips: [{ endSeconds: 8, sourceIndex: 0, startSeconds: 0, title: 'Cambio di stato' }],
          type: 'youtube-clips',
        },
      ],
    };

    expect(
      findUncheckedLessonVerificationStructuralCheckIds(
        imageContext,
        verifiedWithImageRef,
        imageCheckedIds
      )
    ).toEqual([]);
    expect(
      findUncheckedLessonVerificationStructuralCheckIds(
        youtubeContext,
        verifiedWithYoutube,
        youtubeCheckedIds
      )
    ).toEqual([]);
  });

  test('allows task-repair features introduced under always-available checks', () => {
    const checkedIds = buildRequiredLessonVerificationCheckIds(EMPTY_CHECK_CONTEXT, plainDraft);
    const verifiedWithGeneratedVisual: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [
        ...plainDraft.contentBlocks,
        { slotId: 'visual-1', type: 'generated-visual' },
      ],
      generatedVisuals: [generatedVisual],
    };
    const verifiedWithQuiz: LessonContentDraft = {
      ...plainDraft,
      contentBlocks: [...plainDraft.contentBlocks, inlineQuizBlock],
    };

    expect(
      findUncheckedLessonVerificationStructuralCheckIds(
        { imageCandidates: [], instructionPacks: [], sources: [] },
        verifiedWithGeneratedVisual,
        checkedIds
      )
    ).toEqual([]);
    expect(
      findUncheckedLessonVerificationStructuralCheckIds(
        { imageCandidates: [], instructionPacks: [], sources: [] },
        verifiedWithQuiz,
        checkedIds
      )
    ).toEqual([]);
  });
});
