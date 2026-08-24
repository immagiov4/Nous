import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { retryLessonGenerationCorrection } from '../../src/services/lessonGenerationCorrection.js';
import { resolveLessonVisualModelConfig } from '../../src/services/lessonVisualModelConfig.js';
import {
  createLessonGenerationStageServices,
  type LessonGenerationStageDependencies,
} from '../../src/workflows/lessonGenerationStageServices.js';
import { LessonDraftStateSchema } from '../../src/workflows/lessonGenerationWorkflowContract.js';

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

describe('lesson generation corrective retries', () => {
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

  test('converts deterministic lesson validation failures into corrective workflow retries', async () => {
    const services = servicesWithReview(
      vi.fn(async () => {
        throw retryLessonGenerationCorrection({
          code: 'lesson_review_report_incomplete',
          feedback: 'Return every required verificationReport item.',
          message: 'The lesson verification report is incomplete.',
        });
      })
    );

    const failure = await services.reviewLesson(stageContext()).catch(error => error);

    expect(failure.failure).toEqual({
      code: 'lesson_review_report_incomplete',
      feedback: 'Return every required verificationReport item.',
      kind: 'corrective',
      message: 'The lesson verification report is incomplete.',
    });
  });
});
