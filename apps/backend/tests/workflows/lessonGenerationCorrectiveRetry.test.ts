import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  buildLessonEvidenceMaterials,
  resolveLessonEvidence,
} from '../../src/services/lessonEvidence.js';
import { retryLessonGenerationCorrection } from '../../src/services/lessonGenerationCorrection.js';
import { reviewLessonContentDraftStrict } from '../../src/services/lessonGenerationModel.js';
import { resolveLessonVisualModelConfig } from '../../src/services/lessonVisualModelConfig.js';
import {
  createLessonGenerationStageServices,
  type LessonGenerationStageDependencies,
} from '../../src/workflows/lessonGenerationStageServices.js';
import { LessonDraftStateSchema } from '../../src/workflows/lessonGenerationWorkflowContract.js';
import type { WorkflowProviderEffectExecutor } from '../../src/workflows/types.js';

const { verifyLessonEvidence } = vi.hoisted(() => ({ verifyLessonEvidence: vi.fn() }));
vi.mock('../../src/services/lessonEvidenceVerification.js', () => ({ verifyLessonEvidence }));

const modelConfig = getGlobalModelConfig();
const config = {
  maxAttempts: 3,
  models: modelConfig,
  timeoutMs: 90_000,
  visual: resolveLessonVisualModelConfig(modelConfig),
};

const draftState = () =>
  LessonDraftStateSchema.parse({
    discoveredYoutubeSources: [],
    documentAssetOwners: [],
    documentSourceHash: null,
    draft: {
      contentBlocks: [{ markdown: '## Lezione\n\nContenuto.', type: 'markdown' }],
      generatedVisuals: [],
      imageRefs: [],
    },
    existingDossierJson: null,
    existingSources: [],
    lessonInputData: {
      description: 'Descrizione',
      imageCandidates: [],
      instructionPacks: [],
      language: 'Italiano',
      pedagogicalContext: '',
      previousLessonTitles: [],
      sectionTitle: 'Titolo',
      sourceContext: 'Fonte',
    },
    lessonSources: [],
    originalSources: [],
    pdfImages: [],
    request: {
      forceRegenerate: true,
      projectId: 'project-1',
      sectionId: 'lesson-1',
      userId: 'user-1',
    },
    requiresCoverageAssessment: false,
    research: { context: '{}', summary: null, youtube: null },
    sourceFingerprint: 'a'.repeat(64),
    stage: 'draft',
    targetFingerprint: 'b'.repeat(64),
    warnings: [],
    youtubePlanning: { courseTitle: 'Corso', keyConcepts: [] },
  });

const stageContext = (retryFeedback = '') => ({
  attemptNumber: retryFeedback ? 2 : 1,
  config,
  execution: { nodeInstanceId: 'review-node', runId: 'run-1' },
  idempotencyKey: 'review-key',
  input: draftState(),
  retryFeedback,
  signal: new AbortController().signal,
});

const servicesWithReview = (reviewContent: LessonGenerationStageDependencies['reviewContent']) =>
  createLessonGenerationStageServices({
    reviewContent,
  } as unknown as LessonGenerationStageDependencies);

const createPersistedReviewExecutor = (
  results: Map<string, unknown>
): WorkflowProviderEffectExecutor => ({
  async run({ key, operation, outputSchema }) {
    if (!results.has(key)) results.set(key, JSON.parse(JSON.stringify(await operation())));
    return outputSchema.parse(results.get(key));
  },
});

describe('lesson generation corrective retries', () => {
  test.each([
    'lesson_factual_review_invalid',
    'malformed-json',
    'transport',
  ])('restores pedagogical output after %s', async failureKind => {
    const paidReview = vi.fn(async ({ draft }) => ({
      ...structuredClone(draft),
      imageRefs: [{ assetId: 'image-1', alt: 'Diagram', caption: 'Supported caption.' }],
    }));
    const reviewContent: LessonGenerationStageDependencies['reviewContent'] = input =>
      reviewLessonContentDraftStrict({ ...input, verify: paidReview });
    const failure =
      failureKind === 'malformed-json'
        ? new SyntaxError('Invalid JSON')
        : failureKind === 'transport'
          ? new Error('Connection interrupted')
          : retryLessonGenerationCorrection({
              code: failureKind,
              feedback: 'Complete factual references.',
              message: 'Incomplete report.',
            });
    verifyLessonEvidence
      .mockReset()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const persisted = new Map<string, unknown>();
    const first = await servicesWithReview(reviewContent)
      .reviewLesson({ ...stageContext(), providerEffect: createPersistedReviewExecutor(persisted) })
      .catch(error => error);
    const feedback = first.failure?.feedback ?? '';
    const accepted = await servicesWithReview(reviewContent).reviewLesson({
      ...stageContext(feedback),
      providerEffect: createPersistedReviewExecutor(persisted),
    });
    expect(paidReview).toHaveBeenCalledTimes(1);
    expect(verifyLessonEvidence).toHaveBeenCalledTimes(2);
    expect(accepted.draft).toEqual({
      ...draftState().draft,
      imageRefs: [
        { assetId: 'image-1', alt: 'Diagram', caption: 'Supported caption.', anchorHeading: '' },
      ],
    });
    expect([...persisted.keys()]).toEqual(['pedagogical-review:0']);
  });

  test('keeps the corrected pedagogical revision when its factual report needs another attempt', async () => {
    const paidReview = vi.fn(async ({ draft }) => ({
      ...draft,
      contentBlocks: [
        { type: 'markdown' as const, markdown: `Revision ${paidReview.mock.calls.length}` },
      ],
    }));
    const reviewContent: LessonGenerationStageDependencies['reviewContent'] = input =>
      reviewLessonContentDraftStrict({ ...input, verify: paidReview });
    verifyLessonEvidence
      .mockReset()
      .mockRejectedValueOnce(
        retryLessonGenerationCorrection({
          code: 'lesson_factual_support_failed',
          feedback: 'Correct the unsupported claim.',
          message: 'Unsupported claim.',
        })
      )
      .mockRejectedValueOnce(
        retryLessonGenerationCorrection({
          code: 'lesson_factual_review_invalid',
          feedback: 'Complete factual references.',
          message: 'Incomplete report.',
        })
      )
      .mockResolvedValueOnce(undefined);
    const persisted = new Map<string, unknown>();
    const providerEffect = createPersistedReviewExecutor(persisted);
    let feedback = '';
    let accepted:
      | Awaited<ReturnType<ReturnType<typeof servicesWithReview>['reviewLesson']>>
      | undefined;
    for (let attemptNumber = 1; attemptNumber <= config.maxAttempts; attemptNumber++) {
      try {
        accepted = await servicesWithReview(reviewContent).reviewLesson({
          ...stageContext(feedback),
          attemptNumber,
          providerEffect,
        });
      } catch (error) {
        feedback = (error as { failure: { feedback: string } }).failure.feedback;
      }
    }
    expect(paidReview).toHaveBeenCalledTimes(2);
    expect(paidReview.mock.calls[1][0].generationInput.retryFeedback).toBe(
      'Correct the unsupported claim.'
    );
    expect(accepted?.draft.contentBlocks).toEqual([{ type: 'markdown', markdown: 'Revision 2' }]);
    expect([...persisted.keys()]).toEqual(['pedagogical-review:0', 'pedagogical-review:1']);
    expect(verifyLessonEvidence.mock.calls[2][1]).toEqual(verifyLessonEvidence.mock.calls[1][1]);
  });

  test('preserves correction A when the next factual finding requires correction B', async () => {
    const initial = stageContext();
    initial.input.draft.contentBlocks = [
      { type: 'markdown', markdown: 'Unsupported A' },
      { type: 'markdown', markdown: 'Unsupported B' },
    ];
    const paidReview = vi.fn(
      async ({
        draft,
        generationInput,
      }: Parameters<LessonGenerationStageDependencies['reviewContent']>[0]) => {
        const corrected = structuredClone(draft);
        if (generationInput.retryFeedback === 'Repair A')
          corrected.contentBlocks[0] = { type: 'markdown', markdown: 'Supported A' };
        if (generationInput.retryFeedback === 'Repair B')
          corrected.contentBlocks[1] = { type: 'markdown', markdown: 'Supported B' };
        return corrected;
      }
    );
    const reviewContent: LessonGenerationStageDependencies['reviewContent'] = input =>
      reviewLessonContentDraftStrict({ ...input, verify: paidReview });
    verifyLessonEvidence
      .mockReset()
      .mockRejectedValueOnce(
        retryLessonGenerationCorrection({
          code: 'lesson_factual_support_failed',
          feedback: 'Repair A',
          message: 'Unsupported A',
        })
      )
      .mockRejectedValueOnce(
        retryLessonGenerationCorrection({
          code: 'lesson_factual_support_failed',
          feedback: 'Repair B',
          message: 'Unsupported B',
        })
      )
      .mockResolvedValueOnce(undefined);
    const persisted = new Map<string, unknown>();
    const attempt = (attemptNumber: number, feedback: string) =>
      servicesWithReview(reviewContent).reviewLesson({
        ...initial,
        attemptNumber,
        retryFeedback: feedback,
        providerEffect: createPersistedReviewExecutor(persisted),
      });
    const first = await attempt(1, '').catch(error => error);
    const second = await attempt(2, first.failure.feedback).catch(error => error);
    const accepted = await attempt(3, second.failure.feedback);
    expect(paidReview.mock.calls[2][0].draft.contentBlocks).toEqual([
      { type: 'markdown', markdown: 'Supported A' },
      { type: 'markdown', markdown: 'Unsupported B' },
    ]);
    expect(accepted.draft.contentBlocks).toEqual([
      { type: 'markdown', markdown: 'Supported A' },
      { type: 'markdown', markdown: 'Supported B' },
    ]);
    expect(initial.input.draft.contentBlocks[0]).toEqual({
      type: 'markdown',
      markdown: 'Unsupported A',
    });
  });

  test('fails explicitly when a required earlier pedagogical revision is missing', async () => {
    const reviewContent = vi.fn();
    await expect(
      servicesWithReview(reviewContent).reviewLesson({
        ...stageContext(
          JSON.stringify({
            kind: 'lesson-review-retry-v1',
            pedagogicalRevision: 1,
            feedback: 'Repair A',
          })
        ),
        providerEffect: createPersistedReviewExecutor(new Map()),
      })
    ).rejects.toThrow('The preceding pedagogical review checkpoint is missing.');
    expect(reviewContent).not.toHaveBeenCalled();
  });

  test('classifies stale restored evidence as corrective before drafting or reviewing', async () => {
    const context = stageContext();
    const materials = buildLessonEvidenceMaterials({
      sourceContext: context.input.lessonInputData.sourceContext,
      researchContext: context.input.research.context,
      sources: context.input.lessonSources,
    });
    const packet = resolveLessonEvidence(materials, {
      materials: materials.map(material => ({
        materialId: material.materialId,
        passages: [],
        overlaps: [],
        reason: 'Not needed for this lesson.',
      })),
    });
    context.input.evidencePacketJson = JSON.stringify({
      version: packet.version,
      materialHash: packet.materialHash,
      selection: packet.selection,
      materials,
    });
    context.input.lessonInputData.sourceContext = 'Changed original material';
    const generateContent = vi.fn();
    const reviewContent = vi.fn();
    const services = createLessonGenerationStageServices({
      generateContent,
      reviewContent,
    } as unknown as LessonGenerationStageDependencies);
    const draftFailure = await services
      .draftLesson({
        ...context,
        input: { ...context.input, stage: 'research' },
      })
      .catch(error => error);
    const reviewFailure = await services.reviewLesson(context).catch(error => error);
    for (const error of [draftFailure, reviewFailure]) {
      expect(error.failure).toMatchObject({
        kind: 'corrective',
        code: 'lesson_evidence_selection_invalid',
      });
    }
    expect(generateContent).not.toHaveBeenCalled();
    expect(reviewContent).not.toHaveBeenCalled();
  });
  test('passes durable corrective feedback into the next lesson review request', async () => {
    const reviewContent = vi.fn(async ({ draft }) => draft);
    const services = servicesWithReview(reviewContent);

    await services.reviewLesson(
      stageContext('Return every required verificationReport item with non-empty evidence.')
    );

    expect(reviewContent).toHaveBeenCalledWith(
      expect.objectContaining({
        generationInput: expect.objectContaining({
          retryFeedback: 'Return every required verificationReport item with non-empty evidence.',
        }),
      })
    );
  });

  test.each([
    'lesson_review_report_incomplete',
    'lesson_review_integrity_invalid',
    'lesson_review_integrity_failed',
    'lesson_review_checks_failed',
  ])('propagates %s as a corrective workflow failure', async code => {
    const services = servicesWithReview(
      vi.fn(async () => {
        throw retryLessonGenerationCorrection({
          code,
          feedback: 'Return every required verificationReport item.',
          message: 'The lesson verification report is incomplete.',
        });
      })
    );

    const failure = await services.reviewLesson(stageContext()).catch(error => error);

    expect(failure.failure).toEqual({
      code,
      feedback: 'Return every required verificationReport item.',
      kind: 'corrective',
      message: 'The lesson verification report is incomplete.',
    });
  });

  test('retries a failed quality review from the durable draft and returns only the accepted lesson', async () => {
    const feedback =
      'Teach the concept before its active pause and remove the unrelated type fragment.';
    const reviewContent = vi
      .fn<LessonGenerationStageDependencies['reviewContent']>()
      .mockRejectedValueOnce(
        retryLessonGenerationCorrection({
          code: 'lesson_review_checks_failed',
          feedback,
          message: 'The reviewed lesson still fails required checks.',
        })
      )
      .mockImplementationOnce(async ({ draft }) => draft);
    const services = servicesWithReview(reviewContent);
    const firstContext = stageContext();
    firstContext.input.draft.contentBlocks = [
      { type: 'markdown', markdown: '## Durable lesson\n\nPreserve this saved draft.' },
    ];
    const failure = await services.reviewLesson(firstContext).catch(error => error);
    expect(failure.failure).toMatchObject({ kind: 'corrective', feedback });
    const accepted = await services.reviewLesson({
      ...stageContext(failure.failure.feedback),
      input: firstContext.input,
    });
    expect(accepted.stage).toBe('review');
    expect(accepted.draft.contentBlocks).toEqual(firstContext.input.draft.contentBlocks);
    expect(reviewContent.mock.calls[1][0]).toMatchObject({
      draft: reviewContent.mock.calls[0][0].draft,
      generationInput: { retryFeedback: feedback },
    });
  });
});
