import { describe, expect, test } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { resolveLessonVisualModelConfig } from '../../src/services/lessonVisualModelConfig.js';
import { createLessonNormalizationStage } from '../../src/workflows/lessonGenerationNormalizationStage.js';
import { LessonAidsStateSchema } from '../../src/workflows/lessonGenerationWorkflowContract.js';

const visualPlan = (slotId: string) => ({
  altText: `Schema ${slotId}`,
  anchorHeading: 'Concetto',
  complexity: 'simple' as const,
  concept: `Concetto ${slotId}`,
  coverage: 'single_complex' as const,
  coverageRationale: 'Mostra il concetto.',
  factualRequirements: ['Vincolo'],
  interactionLevel: 'none' as const,
  pedagogicalGoal: 'Chiarire il concetto.',
  reason: 'Serve una struttura.',
  requiresDepiction: false,
  slotId,
  title: `Schema ${slotId}`,
  visualDirection: 'Diagramma semplice.',
  visualType: 'structural_svg' as const,
});

const modelConfig = getGlobalModelConfig();
const config = {
  maxAttempts: 3,
  models: modelConfig,
  timeoutMs: 90_000,
  visual: resolveLessonVisualModelConfig(modelConfig),
};

const lesson = LessonAidsStateSchema.parse({
  discoveredYoutubeSources: [],
  documentAssetOwners: [],
  documentSourceHash: null,
  draft: {
    contentBlocks: [
      { markdown: '## Concetto\n\nSpiegazione.', type: 'markdown' },
      { slotId: 'success', type: 'generated-visual' },
      { markdown: '## Secondo\n\nAltra spiegazione.', type: 'markdown' },
      { slotId: 'failed', type: 'generated-visual' },
    ],
    generatedVisuals: [visualPlan('success'), visualPlan('failed')],
    imageRefs: [],
  },
  existingDossierJson: null,
  existingSources: [],
  learningAids: [],
  lessonInputData: {
    description: 'Descrizione',
    imageCandidates: [],
    instructionPacks: [],
    language: 'Italiano',
    pedagogicalContext: '',
    previousLessonTitles: [],
    sectionTitle: 'Lezione',
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
  research: { context: '', summary: null, youtube: null },
  sourceFingerprint: 'a'.repeat(64),
  stage: 'aids',
  targetFingerprint: 'b'.repeat(64),
  warnings: [],
  youtubePlanning: { courseTitle: 'Corso', keyConcepts: [] },
});

describe('durable lesson normalization', () => {
  test('keeps a valid YouTube clip that spans multiple transcript cues', async () => {
    const youtubeLesson = LessonAidsStateSchema.parse({
      ...lesson,
      draft: {
        contentBlocks: [
          { markdown: '## Processo\n\nSpiegazione.', type: 'markdown' },
          {
            clips: [
              { endSeconds: 75, sourceIndex: 0, startSeconds: 10, title: 'Clip valida' },
              { endSeconds: 100, sourceIndex: 0, startSeconds: 10, title: 'Clip fuori limite' },
            ],
            type: 'youtube-clips',
          },
        ],
        generatedVisuals: [],
        imageRefs: [],
      },
      lessonSources: [
        {
          title: 'Video selezionato',
          url: 'https://www.youtube.com/watch?v=abcdefghijk',
          youtubeTranscript: {
            segments: [
              { endSeconds: 30, startSeconds: 0, text: 'Primo cue.' },
              { endSeconds: 60, startSeconds: 30, text: 'Secondo cue.' },
              { endSeconds: 90, startSeconds: 60, text: 'Terzo cue.' },
            ],
          },
        },
      ],
    });

    const output = await createLessonNormalizationStage({
      now: () => '2026-07-29T22:00:00.000Z',
    })({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'normalize', runId: 'run-1' },
      idempotencyKey: 'normalize-youtube',
      input: { lesson: youtubeLesson, stage: 'visual-results', visualResults: [] },
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(output.contentBlocks).toContainEqual({
      clips: [{ endSeconds: 75, sourceIndex: 0, startSeconds: 10, title: 'Clip valida' }],
      type: 'youtube-clips',
    });
  });

  test('enforces the shared lesson limits for quiz pauses and generated visuals', async () => {
    const plans = Array.from({ length: 4 }, (_, index) => visualPlan(`visual-${index + 1}`));
    const expandedLesson = LessonAidsStateSchema.parse({
      ...lesson,
      draft: {
        contentBlocks: plans.flatMap((plan, index) => [
          {
            markdown: `## Passaggio ${index + 1}\n\nSpiegazione didattica ${index + 1}.`,
            type: 'markdown' as const,
          },
          {
            quiz: {
              correctIndex: 0,
              exerciseType: 'recall',
              options: ['A', 'B', 'C', 'D'],
              question: `Domanda ${index + 1}`,
            },
            type: 'inline-quiz' as const,
          },
          { slotId: plan.slotId, type: 'generated-visual' as const },
        ]),
        generatedVisuals: plans,
        imageRefs: [],
      },
    });
    const visualResults = plans.map((plan, index) => ({
      assetOwners: [
        {
          assetIds: [String(index + 5).repeat(64)],
          nodeInstanceId: `render-${plan.slotId}`,
        },
      ],
      slotId: plan.slotId,
      status: 'completed' as const,
      visual: {
        createdAt: '2026-07-29T21:59:00.000Z',
        id: `rendered-${plan.slotId}`,
        render: {
          asset: {
            byteSize: 5,
            hash: String(index + 1).repeat(64),
            id: String(index + 5).repeat(64),
            mediaType: 'image/png',
          },
          kind: 'image' as const,
        },
        slotId: plan.slotId,
      },
    }));

    const output = await createLessonNormalizationStage({
      now: () => '2026-07-29T22:00:00.000Z',
    })({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'normalize', runId: 'run-1' },
      idempotencyKey: 'normalize-limits',
      input: { lesson: expandedLesson, stage: 'visual-results', visualResults },
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(output.quiz).toHaveLength(3);
    expect(output.generatedVisuals).toHaveLength(3);
    expect(output.contentBlocks.filter(block => block.type === 'inline-quiz')).toHaveLength(3);
    expect(output.contentBlocks.filter(block => block.type === 'generated-visual')).toHaveLength(3);
  });

  test('keeps successful durable visuals and turns failures into retryable blocks', async () => {
    const asset = {
      byteSize: 5,
      hash: 'b'.repeat(64),
      id: 'c'.repeat(64),
      mediaType: 'image/png',
    };
    const normalize = createLessonNormalizationStage({
      now: () => '2026-07-29T22:00:00.000Z',
    });
    const output = await normalize({
      attemptNumber: 1,
      config,
      execution: { nodeInstanceId: 'normalize', runId: 'run-1' },
      idempotencyKey: 'normalize-key',
      input: {
        lesson,
        stage: 'visual-results',
        visualResults: [
          {
            assetOwners: [{ assetIds: [asset.id], nodeInstanceId: 'render-success' }],
            slotId: 'success',
            status: 'completed',
            visual: {
              createdAt: '2026-07-29T21:59:00.000Z',
              id: 'visual-success',
              render: { asset, kind: 'image' },
              slotId: 'success',
            },
          },
          {
            failure: {
              code: 'visual_failed',
              kind: 'operational',
              message: 'Visual failed.',
            },
            slotId: 'failed',
            status: 'failed',
          },
        ],
      },
      retryFeedback: '',
      signal: new AbortController().signal,
    });

    expect(output.generatedVisuals).toEqual([
      expect.objectContaining({ id: 'visual-success', slotId: 'success' }),
    ]);
    expect(output.contentBlocks).toEqual(
      expect.arrayContaining([
        { slotId: 'success', type: 'generated-visual', visualId: 'visual-success' },
        expect.objectContaining({ slotId: 'failed', type: 'generated-visual' }),
      ])
    );
    expect(
      output.contentBlocks.find(
        block => block.type === 'generated-visual' && block.slotId === 'failed'
      )
    ).toHaveProperty('retryPlan');
    expect(output.visualAssetOwners).toEqual([
      { assetIds: [asset.id], nodeInstanceId: 'render-success' },
    ]);
    expect(output.documentAssets).toBeNull();
    expect(output.warnings).toEqual([
      {
        code: 'lesson_visual_generation_incomplete',
        stage: 'visuals',
        subjectId: 'failed',
      },
    ]);
  });
});
