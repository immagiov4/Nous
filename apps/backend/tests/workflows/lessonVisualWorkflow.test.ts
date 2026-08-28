import type { ProjectAssetRef } from '@shared/projectAsset';
import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import { buildLessonVisualContextFingerprint } from '../../src/workflows/lessonVisualContext.js';
import {
  createLessonVisualWorkflows,
  type LessonVisualWorkflowConfig,
  type LessonVisualWorkflowInput,
  type LessonVisualWorkflowResult,
  type LessonVisualWorkflowServices,
} from '../../src/workflows/lessonVisualWorkflow.js';
import type { WorkflowProviderEffectExecutor } from '../../src/workflows/types.js';

const FIRST_ASSET_ID = 'a'.repeat(64);
const SECOND_ASSET_ID = 'b'.repeat(64);
const RUN_ID = '11111111-1111-4111-8111-111111111111';

const config: LessonVisualWorkflowConfig = {
  maxAttempts: 3,
  timeoutMs: 60_000,
  visual: {
    artifact: { model: 'artifact', provider: 'openrouter', reasoningEffort: 'low' },
    artifactInteractive: {
      model: 'interactive',
      provider: 'codex',
      reasoningEffort: 'low',
    },
    image: { model: 'image', provider: 'openrouter' },
    review: { enabled: true, maxRounds: 1 },
  },
};

const input: LessonVisualWorkflowInput = {
  contextFingerprint: buildLessonVisualContextFingerprint({
    lessonMarkdown: '## Intreccio\n\nTrama e ordito si incrociano.',
    sectionDescription: 'Riconoscere trama e ordito.',
    sectionTitle: 'Intreccio',
  }),
  lessonMarkdown: '## Intreccio\n\nTrama e ordito si incrociano.',
  plan: {
    altText: 'Intreccio del tessuto',
    anchorHeading: 'Intreccio',
    complexity: 'moderate',
    concept: 'Intreccio di trama e ordito',
    coverage: 'complete_synthesis',
    coverageRationale: 'Mostra la struttura.',
    factualRequirements: ['Fili perpendicolari'],
    interactionLevel: 'low',
    pedagogicalGoal: 'Riconoscere l intreccio',
    reason: 'Confronto visivo',
    requiresDepiction: false,
    slotId: 'visual-intreccio',
    title: 'Intreccio',
    visualDirection: 'Macro ordinata',
    visualType: 'interactive_html',
  },
  projectId: 'project-1',
  sectionDescription: 'Riconoscere trama e ordito.',
  sectionId: 'section-1',
  sectionTitle: 'Intreccio',
  userId: 'user-1',
};

const assetRef = (id: string, mediaType = 'image/png'): ProjectAssetRef => ({
  byteSize: 4,
  hash: id,
  id,
  mediaType,
});

const makeServices = (
  overrides: Partial<LessonVisualWorkflowServices> = {}
): LessonVisualWorkflowServices => ({
  assets: { stage: vi.fn(async () => assetRef(FIRST_ASSET_ID)) },
  finalizeRetryResult: vi.fn(async ({ input: rendered }) => ({
    ...rendered,
    projectRevision: 5,
  })),
  generateArtifact: vi.fn(async () => ({
    code: '<svg viewBox="0 0 680 200"></svg>',
    imageRequests: [],
    kind: 'svg' as const,
  })),
  generateEmbeddedImage: vi.fn(async () => ({
    bytes: new Uint8Array([1]),
    mediaType: 'image/png' as const,
  })),
  generateRaster: vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3, 4]),
    mediaType: 'image/png' as const,
  })),
  now: () => '2026-07-29T17:00:00.000Z',
  persistRetryResult: vi.fn(async () => undefined),
  reviseArtifact: vi.fn(async ({ visual }) => visual),
  undoRetryResult: vi.fn(async () => undefined),
  ...overrides,
});

const execution = (nodeInstanceId: string) => Object.freeze({ nodeInstanceId, runId: RUN_ID });
const providerEffect: WorkflowProviderEffectExecutor = {
  run: ({ operation }) => operation(),
};

const getRenderRoute = (workflowConfig = config) => {
  const route = createLessonVisualWorkflows(workflowConfig).render.root;
  if (route.kind !== 'routeBy') throw new TypeError('Expected the visual format route.');
  return route;
};

const getArtifactNodes = (workflowConfig = config) => {
  const artifact = getRenderRoute(workflowConfig).cases.artifact;
  if (artifact?.kind !== 'sequence') throw new TypeError('Expected the artifact sequence.');
  const [generate, review, images] = artifact.nodes;
  if (generate?.kind !== 'step' || review?.kind !== 'repeat' || images?.kind !== 'fanOut') {
    throw new TypeError('Expected generate, review and embedded-image nodes.');
  }
  if (review.body.kind !== 'step' || images.worker.kind !== 'step') {
    throw new TypeError('Expected step workers.');
  }
  return { generate, images, imageWorker: images.worker, review, reviewStep: review.body };
};

describe('lesson visual workflows', () => {
  test('declares real raster and artifact composition boundaries', () => {
    const route = getRenderRoute();
    const raster = route.cases.raster;
    const { generate, images, imageWorker, review, reviewStep } = getArtifactNodes();

    expect(raster).toMatchObject({
      externalEffect: 'provider-with-postprocessing',
      id: 'render-raster',
      kind: 'step',
    });
    expect(generate.id).toBe('generate-artifact');
    expect(review).toMatchObject({
      id: 'review-artifact-until-done',
      kind: 'repeat',
      maxIterations: 4,
    });
    expect(reviewStep.id).toBe('review-artifact');
    expect(images).toMatchObject({
      failureMode: 'fail-fast',
      id: 'materialize-artifact-images',
      kind: 'fanOut',
    });
    expect(imageWorker).toMatchObject({
      externalEffect: 'provider-with-postprocessing',
      id: 'render-embedded-image',
    });
  });

  test('raster generation stages bytes before checkpointing the asset reference', async () => {
    const raster = getRenderRoute(config).cases.raster;
    if (raster?.kind !== 'step') throw new TypeError('Expected the raster step.');
    const stage = vi.fn(async () => assetRef(FIRST_ASSET_ID));
    const generateRaster = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mediaType: 'image/png' as const,
    }));
    const services = makeServices({ assets: { stage }, generateRaster });
    const signal = new AbortController().signal;
    const rasterInput = {
      ...input,
      plan: { ...input.plan, visualType: 'illustrative_image' as const },
    };

    const result = await raster.run({
      attemptNumber: 1,
      config,
      execution: execution('route-visual-format/raster'),
      idempotencyKey: 'raster-key',
      input: rasterInput,
      providerEffect,
      retryFeedback: '',
      services,
      signal,
    });

    expect(result).toMatchObject({
      assetOwners: [{ assetIds: [FIRST_ASSET_ID], nodeInstanceId: 'route-visual-format/raster' }],
      visual: { render: { asset: assetRef(FIRST_ASSET_ID), kind: 'image' } },
    });
    expect(JSON.stringify(result)).not.toContain('[1,2,3,4]');
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes: new Uint8Array([1, 2, 3, 4]),
        nodeInstanceId: 'route-visual-format/raster',
        signal,
      })
    );
  });

  test('moves invalid artifact correction to the next durable attempt with feedback', async () => {
    const { generate } = getArtifactNodes();
    const generateArtifact = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        code: '<style></style><div>Corretto</div><script></script>',
        imageRequests: [],
        kind: 'html' as const,
      });
    const services = makeServices({ generateArtifact });
    const signal = new AbortController().signal;

    const failure = await generate
      .run({
        attemptNumber: 1,
        config,
        execution: execution('artifact/generate'),
        idempotencyKey: 'generate-key',
        input,
        retryFeedback: '',
        services,
        signal,
      })
      .catch(error => error);

    expect(failure).toMatchObject({
      failure: {
        feedback: expect.any(String),
        kind: 'corrective',
      },
    });
    expect(generateArtifact).toHaveBeenCalledOnce();

    const retryFeedback = failure.failure.feedback as string;
    await expect(
      generate.run({
        attemptNumber: 2,
        config,
        execution: execution('artifact/generate'),
        idempotencyKey: 'generate-key',
        input,
        retryFeedback,
        services,
        signal,
      })
    ).resolves.toMatchObject({ draft: { code: expect.stringContaining('Corretto') } });
    expect(generateArtifact).toHaveBeenCalledTimes(2);
    expect(generateArtifact.mock.calls[1]?.[0]).toMatchObject({ retryFeedback });
  });

  test('review repeats one LLM revision and embedded images fan out into a pure ordered fan-in', async () => {
    const reviewConfig: LessonVisualWorkflowConfig = {
      ...config,
      visual: { ...config.visual, review: { enabled: true, maxRounds: 2 } },
    };
    const { generate, images, imageWorker, reviewStep } = getArtifactNodes(reviewConfig);
    const requests = [
      { alt: 'Primo', id: 'first', prompt: 'Prima immagine' },
      { alt: 'Secondo', id: 'second', prompt: 'Seconda immagine' },
    ];
    const revisedCode =
      '<style></style><img src="{{GENERATED_IMAGE:first}}"><img src="{{GENERATED_IMAGE:second}}"><script></script>';
    const reviseArtifact = vi.fn(async () => ({
      code: revisedCode,
      imageRequests: requests,
      kind: 'html' as const,
    }));
    const stage = vi
      .fn()
      .mockResolvedValueOnce(assetRef(FIRST_ASSET_ID))
      .mockResolvedValueOnce(assetRef(SECOND_ASSET_ID, 'image/webp'));
    const services = makeServices({
      assets: { stage },
      generateArtifact: vi.fn(async () => ({
        code: '<style></style><div></div><script></script>',
        imageRequests: [],
        kind: 'html' as const,
      })),
      generateEmbeddedImage: vi
        .fn()
        .mockResolvedValueOnce({ bytes: new Uint8Array([1]), mediaType: 'image/png' })
        .mockResolvedValueOnce({ bytes: new Uint8Array([2]), mediaType: 'image/webp' }),
      reviseArtifact,
    });
    const signal = new AbortController().signal;
    const generated = await generate.run({
      attemptNumber: 1,
      config: reviewConfig,
      execution: execution('artifact/generate'),
      idempotencyKey: 'generate-key',
      input,
      retryFeedback: '',
      services,
      signal,
    });
    const firstReview = await reviewStep.run({
      attemptNumber: 1,
      config: reviewConfig,
      execution: execution('artifact/review/iteration:1'),
      idempotencyKey: 'review-key',
      input: generated,
      retryFeedback: '',
      services,
      signal,
    });
    expect(firstReview).toMatchObject({ kind: 'continue', state: { reviewRound: 1 } });
    if (firstReview.kind !== 'continue') throw new TypeError('Expected another review round.');
    const reviewed = await reviewStep.run({
      attemptNumber: 1,
      config: reviewConfig,
      execution: execution('artifact/review/iteration:2'),
      idempotencyKey: 'review-key-2',
      input: firstReview.state,
      retryFeedback: '',
      services,
      signal,
    });
    expect(reviewed).toMatchObject({ kind: 'finish', state: { reviewRound: 2 } });
    expect(reviseArtifact).toHaveBeenCalledTimes(2);
    if (reviewed.kind !== 'finish') throw new TypeError('Expected review completion.');

    const imageInputs = images.inputs(reviewed.state);
    expect(imageInputs.map(image => image.request.id)).toEqual(['first', 'second']);
    const completedImages = [];
    for (const [index, imageInput] of imageInputs.entries()) {
      const output = await imageWorker.run({
        attemptNumber: 1,
        config: reviewConfig,
        execution: execution(`artifact/images/item:${imageInput.request.id}`),
        idempotencyKey: `image-${index}`,
        input: imageInput,
        providerEffect,
        retryFeedback: '',
        services,
        signal,
      });
      completedImages.push({
        input: imageInput,
        key: imageInput.request.id,
        output,
        status: 'completed' as const,
      });
    }
    const result = images.fanIn(completedImages, reviewed.state);

    expect(result.visual.render).toEqual({
      code: `<style></style><img src="{{PROJECT_ASSET:${FIRST_ASSET_ID}}}"><img src="{{PROJECT_ASSET:${SECOND_ASSET_ID}}}"><script></script>`,
      embeddedAssets: [assetRef(FIRST_ASSET_ID), assetRef(SECOND_ASSET_ID, 'image/webp')],
      kind: 'html',
    });
    expect(result.assetOwners).toEqual([
      { assetIds: [FIRST_ASSET_ID], nodeInstanceId: 'artifact/images/item:first' },
      { assetIds: [SECOND_ASSET_ID], nodeInstanceId: 'artifact/images/item:second' },
    ]);
    expect(JSON.stringify(result)).not.toContain('GENERATED_IMAGE');
    expect(stage).toHaveBeenCalledTimes(2);
  });

  test('preserves only source HTML assets still referenced by the replacement', () => {
    const { images } = getArtifactNodes();
    const retainedAsset = assetRef(FIRST_ASSET_ID);
    const removedAsset = assetRef(SECOND_ASSET_ID);
    const replacementState = {
      createdAt: '2026-07-29T17:00:00.000Z',
      draft: {
        code: `<style></style><img src="{{PROJECT_ASSET:${FIRST_ASSET_ID}}}"><script></script>`,
        imageRequests: [],
        kind: 'html' as const,
      },
      input: { ...input, existingEmbeddedAssets: [retainedAsset, removedAsset] },
      reviewRound: 0,
      visualId: `lesson-visual:${RUN_ID}:visual-intreccio`,
    };

    const result = images.fanIn([], replacementState);

    expect(result.visual.render).toEqual({
      code: replacementState.draft.code,
      embeddedAssets: [retainedAsset],
      kind: 'html',
    });
    expect(result.assetOwners).toEqual([]);
  });

  test('the retry wrapper adopts distributed owners and publishes the committed revision', async () => {
    const persistRetryResult = vi.fn(async () => undefined);
    const undoRetryResult = vi.fn(async () => undefined);
    const finalizeRetryResult = vi.fn(async ({ input: rendered }) => ({
      ...rendered,
      projectRevision: 8,
    }));
    const services = makeServices({
      finalizeRetryResult,
      persistRetryResult,
      undoRetryResult,
    });
    const workflows = createLessonVisualWorkflows(config);
    const rendered: LessonVisualWorkflowResult = {
      assetOwners: [{ assetIds: [FIRST_ASSET_ID], nodeInstanceId: 'artifact/images/item:first' }],
      target: {
        contextFingerprint: input.contextFingerprint,
        plan: input.plan,
        projectId: input.projectId,
        sectionId: input.sectionId,
        userId: input.userId,
      },
      visual: {
        createdAt: '2026-07-29T17:00:00.000Z',
        id: `lesson-visual:${RUN_ID}:visual-intreccio`,
        render: { code: '<svg></svg>', kind: 'svg' },
        slotId: input.plan.slotId,
      },
    };
    const persistStep = workflows.retry.root.nodes[1];
    const finalizeStep = workflows.retry.root.nodes[2];
    const publishEvent = workflows.retry.root.nodes[3];
    if (persistStep?.kind !== 'step' || finalizeStep?.kind !== 'step') {
      throw new TypeError('Expected retry persistence steps.');
    }
    if (publishEvent?.kind !== 'emit') throw new TypeError('Expected project revision event.');
    const persistExecution = execution('root/persist-retry-result');
    const output = await persistStep.run({
      attemptNumber: 1,
      config,
      execution: persistExecution,
      idempotencyKey: 'persist-key',
      input: rendered,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });
    await persistStep.commit?.({
      config,
      execution: persistExecution,
      input: rendered,
      output,
      services,
      transaction: {} as TransactionSql,
    });
    await persistStep.undo?.({
      config,
      execution: persistExecution,
      idempotencyKey: 'undo-key',
      input: rendered,
      output,
      services,
      signal: new AbortController().signal,
    });
    const finalized = await finalizeStep.run({
      attemptNumber: 1,
      config,
      execution: execution('root/finalize-retry-result'),
      idempotencyKey: 'finalize-key',
      input: rendered,
      retryFeedback: '',
      services,
      signal: new AbortController().signal,
    });

    expect(persistRetryResult).toHaveBeenCalledWith(
      expect.objectContaining({ input: rendered, transaction: expect.anything() })
    );
    expect(undoRetryResult).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'undo-key', input: rendered })
    );
    expect(finalized.projectRevision).toBe(8);
    expect(publishEvent.payload(finalized)).toEqual({ projectId: 'project-1', revision: 8 });
  });

  test('registers only the committing workflow as a top-level start target', () => {
    interface LessonConfig extends LessonVisualWorkflowConfig {
      lessonModel: string;
    }
    interface LessonServices extends LessonVisualWorkflowServices {
      loadLesson(): Promise<void>;
    }
    const lessonConfig: LessonConfig = { ...config, lessonModel: 'lesson' };
    const workflows = createLessonVisualWorkflows<LessonConfig, LessonServices>(lessonConfig);
    const registry = createWorkflowRegistry();

    expect(workflows.render.executionDefaults).toEqual(lessonConfig);
    expect(() => registry.register({ current: workflows.retry })).not.toThrow();
    expect(registry.current('render-lesson-visual')).toBeNull();
  });
});
