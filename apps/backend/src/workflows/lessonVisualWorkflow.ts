import {
  buildProjectAssetPlaceholder,
  type ProjectAssetRef,
  type ProjectLessonVisual,
  validateProjectAssetHtmlReferences,
} from '@shared/projectAsset';
import type { TransactionSql } from 'postgres';
import * as z from 'zod';

import type { StageProjectAssetInput } from '../projects/projectAsset.js';
import { inspectLessonVisualForReview } from '../services/lessonGenerationVisualReview.js';
import type {
  GeneratedLessonVisualImage,
  GenerateEmbeddedLessonVisualImageInput,
  RenderedArtifactDraft,
  RenderResolvedLessonVisualInput,
  ReviseLessonVisualArtifactInput,
} from '../services/lessonGenerationVisuals.js';
import {
  type LessonVisualModelConfig,
  LessonVisualModelConfigSchema,
  MAX_LESSON_VISUAL_REVIEW_ROUNDS,
} from '../services/lessonVisualModelConfig.js';
import { WorkflowExecutionDefaultsSchema } from './config.js';
import {
  continueRepeatWith,
  emit,
  fanOut,
  finishRepeat,
  repeat,
  repeatDecisionSchema,
  routeBy,
  sequence,
  step,
  workflow,
} from './definition.js';
import {
  LessonVisualRetryPlanSchema,
  ProjectAssetRefSchema,
  ProjectLessonVisualSchema,
  type ProjectVisualSchema,
} from './lessonGenerationWorkflowSchemas.js';
import {
  LESSON_PROJECT_REVISION_EVENT,
  PROJECT_REVISION_EVENT_SCHEMA_VERSION,
  ProjectRevisionEventSchema,
} from './projectRevisionNotifications.js';
import { failPermanently, retryCorrective } from './retryPolicy.js';
import type {
  WorkflowExecutionDefaults,
  WorkflowProviderEffectExecutor,
  WorkflowStepExecutionIdentity,
} from './types.js';

type DurableProjectVisual = z.infer<typeof ProjectVisualSchema>;

export const LessonVisualWorkflowInputSchema = z.object({
  contextFingerprint: z.string().length(64),
  existingEmbeddedAssets: z.array(ProjectAssetRefSchema).optional(),
  lessonMarkdown: z.string().min(1),
  plan: LessonVisualRetryPlanSchema,
  projectId: z.string().min(1),
  sectionDescription: z.string(),
  sectionId: z.string().min(1),
  sectionTitle: z.string().min(1),
  userId: z.string().min(1),
});

const LessonVisualAssetOwnerSchema = z.object({
  assetIds: z.array(z.string().length(64)).min(1),
  nodeInstanceId: z.string().min(1),
});

export const LESSON_VISUAL_RETRY_WORKFLOW_ID = 'retry-lesson-visual';

export const LessonVisualWorkflowResultSchema = z.object({
  assetOwners: z.array(LessonVisualAssetOwnerSchema),
  target: z.object({
    contextFingerprint: z.string().length(64),
    plan: LessonVisualRetryPlanSchema,
    projectId: z.string().min(1),
    sectionId: z.string().min(1),
    userId: z.string().min(1),
  }),
  visual: ProjectLessonVisualSchema,
});

const LessonVisualRetryWorkflowResultSchema = LessonVisualWorkflowResultSchema.extend({
  projectRevision: z.number().int().nonnegative(),
});

const LessonVisualWorkflowConfigSchema = WorkflowExecutionDefaultsSchema.extend({
  visual: LessonVisualModelConfigSchema,
});

export type LessonVisualWorkflowConfig = WorkflowExecutionDefaults & {
  readonly visual: LessonVisualModelConfig;
};
export type LessonVisualWorkflowInput = z.infer<typeof LessonVisualWorkflowInputSchema>;
export type LessonVisualWorkflowResult = z.infer<typeof LessonVisualWorkflowResultSchema>;
export type LessonVisualRetryWorkflowResult = z.infer<typeof LessonVisualRetryWorkflowResultSchema>;

export interface LessonVisualWorkflowServices {
  readonly assets: {
    stage(input: StageProjectAssetInput): Promise<ProjectAssetRef>;
  };
  readonly finalizeRetryResult: (input: {
    execution: WorkflowStepExecutionIdentity;
    input: LessonVisualWorkflowResult;
  }) => Promise<LessonVisualRetryWorkflowResult>;
  readonly generateArtifact: (
    input: RenderResolvedLessonVisualInput
  ) => Promise<RenderedArtifactDraft | null>;
  readonly generateEmbeddedImage: (
    input: GenerateEmbeddedLessonVisualImageInput
  ) => Promise<GeneratedLessonVisualImage>;
  readonly generateRaster: (
    input: RenderResolvedLessonVisualInput
  ) => Promise<GeneratedLessonVisualImage>;
  readonly now: () => string;
  readonly persistRetryResult: (input: {
    execution: WorkflowStepExecutionIdentity;
    input: LessonVisualWorkflowResult;
    transaction: TransactionSql;
  }) => Promise<void>;
  readonly reviseArtifact: (
    input: ReviseLessonVisualArtifactInput
  ) => Promise<RenderedArtifactDraft | null>;
  readonly undoRetryResult: (input: {
    execution: WorkflowStepExecutionIdentity;
    idempotencyKey: string;
    input: LessonVisualWorkflowResult;
    signal: AbortSignal;
  }) => Promise<void>;
}

const ArtifactImageRequestSchema = z.object({
  alt: z.string(),
  id: z.string().min(1),
  prompt: z.string(),
});

const ArtifactDraftSchema = z.object({
  code: z.string().min(1),
  imageRequests: z.array(ArtifactImageRequestSchema),
  kind: z.enum(['html', 'mermaid', 'svg']),
});

const ArtifactReviewStateSchema = z.object({
  createdAt: z.string().min(1),
  draft: ArtifactDraftSchema,
  input: LessonVisualWorkflowInputSchema,
  reviewRound: z.number().int().nonnegative(),
  visualId: z.string().min(1),
});
const ArtifactReviewDecisionSchema = repeatDecisionSchema(ArtifactReviewStateSchema);

const EmbeddedImageInputSchema = z.object({
  input: LessonVisualWorkflowInputSchema,
  request: ArtifactImageRequestSchema,
});

const EmbeddedImageOutputSchema = z.object({
  asset: ProjectAssetRefSchema,
  id: z.string().min(1),
  nodeInstanceId: z.string().min(1),
});

const GeneratedImageProviderResultSchema = z.object({
  data: z.string(),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

const assetIdempotencyKey = (stepKey: string, role: string): string =>
  JSON.stringify(['lesson-visual', stepKey, role]);

const visualServiceInput = (
  config: LessonVisualWorkflowConfig,
  input: LessonVisualWorkflowInput,
  signal: AbortSignal,
  retryFeedback?: string
): RenderResolvedLessonVisualInput => ({
  config: config.visual,
  existingEmbeddedAssets: input.existingEmbeddedAssets,
  lessonMarkdown: input.lessonMarkdown,
  plan: input.plan,
  ...(retryFeedback ? { retryFeedback } : {}),
  sectionDescription: input.sectionDescription,
  sectionTitle: input.sectionTitle,
  signal,
});

const runDurableImageProvider = async (
  providerEffect: WorkflowProviderEffectExecutor | undefined,
  operation: () => Promise<GeneratedLessonVisualImage>
): Promise<z.infer<typeof GeneratedImageProviderResultSchema>> => {
  if (!providerEffect) throw new Error('Provider effect persistence is required.');
  return providerEffect.run({
    key: 'generate-image',
    operation: async () => {
      const image = await operation();
      return { data: Buffer.from(image.bytes).toString('base64'), mediaType: image.mediaType };
    },
    outputSchema: GeneratedImageProviderResultSchema,
  });
};

const stageAsset = (input: {
  bytes: Uint8Array;
  execution: WorkflowStepExecutionIdentity;
  mediaType: string;
  role: string;
  services: LessonVisualWorkflowServices;
  signal: AbortSignal;
  stepInput: LessonVisualWorkflowInput;
  stepKey: string;
}): Promise<ProjectAssetRef> =>
  input.services.assets.stage({
    bytes: input.bytes,
    idempotencyKey: assetIdempotencyKey(input.stepKey, input.role),
    mediaType: input.mediaType,
    nodeInstanceId: input.execution.nodeInstanceId,
    projectId: input.stepInput.projectId,
    runId: input.execution.runId,
    signal: input.signal,
    userId: input.stepInput.userId,
  });

const buildStoredVisual = (
  input: LessonVisualWorkflowInput,
  render: DurableProjectVisual,
  createdAt: string,
  visualId: string
): LessonVisualWorkflowResult['visual'] => {
  const altText = input.plan.altText?.trim();
  const anchorHeading = input.plan.anchorHeading?.trim();
  const title = input.plan.title?.trim();
  return {
    ...(altText ? { altText } : {}),
    ...(anchorHeading ? { anchorHeading } : {}),
    createdAt,
    id: visualId,
    render,
    slotId: input.plan.slotId,
    ...(title ? { title } : {}),
  } satisfies ProjectLessonVisual;
};

const buildResult = (input: {
  assetOwners: LessonVisualWorkflowResult['assetOwners'];
  createdAt: string;
  render: DurableProjectVisual;
  stepInput: LessonVisualWorkflowInput;
  visualId: string;
}): LessonVisualWorkflowResult => ({
  assetOwners: input.assetOwners,
  target: {
    contextFingerprint: input.stepInput.contextFingerprint,
    plan: input.stepInput.plan,
    projectId: input.stepInput.projectId,
    sectionId: input.stepInput.sectionId,
    userId: input.stepInput.userId,
  },
  visual: buildStoredVisual(input.stepInput, input.render, input.createdAt, input.visualId),
});

const visualId = (runId: string, slotId: string): string => `lesson-visual:${runId}:${slotId}`;

export const createLessonVisualWorkflows = <
  Config extends LessonVisualWorkflowConfig = LessonVisualWorkflowConfig,
  Services extends LessonVisualWorkflowServices = LessonVisualWorkflowServices,
>(
  executionDefaults: Config,
  configSchema: z.ZodType<Config> = LessonVisualWorkflowConfigSchema as z.ZodType<Config>
) => {
  const renderRaster = step<
    typeof LessonVisualWorkflowInputSchema,
    typeof LessonVisualWorkflowResultSchema,
    Config,
    Services
  >({
    externalEffect: 'provider-with-postprocessing',
    id: 'render-raster',
    inputSchema: LessonVisualWorkflowInputSchema,
    outputSchema: LessonVisualWorkflowResultSchema,
    run: async ({ config, execution, idempotencyKey, input, providerEffect, services, signal }) => {
      const image = await runDurableImageProvider(providerEffect, () =>
        services.generateRaster(visualServiceInput(config, input, signal))
      );
      const asset = await stageAsset({
        bytes: new Uint8Array(Buffer.from(image.data, 'base64')),
        execution,
        mediaType: image.mediaType,
        role: 'image',
        services,
        signal,
        stepInput: input,
        stepKey: idempotencyKey,
      });
      return buildResult({
        assetOwners: [{ assetIds: [asset.id], nodeInstanceId: execution.nodeInstanceId }],
        createdAt: services.now(),
        render: { asset, kind: 'image' },
        stepInput: input,
        visualId: visualId(execution.runId, input.plan.slotId),
      });
    },
  });

  const generateArtifact = step<
    typeof LessonVisualWorkflowInputSchema,
    typeof ArtifactReviewStateSchema,
    Config,
    Services
  >({
    externalEffect: 'provider',
    id: 'generate-artifact',
    inputSchema: LessonVisualWorkflowInputSchema,
    outputSchema: ArtifactReviewStateSchema,
    run: async ({ config, execution, input, retryFeedback, services, signal }) => {
      const draft = await services.generateArtifact(
        visualServiceInput(config, input, signal, retryFeedback)
      );
      if (!draft) {
        throw retryCorrective({
          code: 'lesson_visual_generation_incomplete',
          feedback:
            'La bozza precedente non rispettava il contratto del visuale. Genera una sostituzione completa e valida.',
          message: 'The lesson visual could not be completed.',
        });
      }
      return {
        createdAt: services.now(),
        draft,
        input,
        reviewRound: 0,
        visualId: visualId(execution.runId, input.plan.slotId),
      };
    },
  });

  const reviewArtifact = step<
    typeof ArtifactReviewStateSchema,
    typeof ArtifactReviewDecisionSchema,
    Config,
    Services
  >({
    externalEffect: 'provider',
    id: 'review-artifact',
    inputSchema: ArtifactReviewStateSchema,
    outputSchema: ArtifactReviewDecisionSchema,
    run: async ({ config, input, services, signal }) => {
      if (!config.visual.review.enabled || input.reviewRound >= config.visual.review.maxRounds) {
        return finishRepeat(input);
      }
      const review = inspectLessonVisualForReview({ visual: input.draft });
      if (!review) return finishRepeat(input);
      const revision = await services.reviseArtifact({
        ...visualServiceInput(config, input.input, signal),
        issues: review.issues,
        ...(review.preview ? { preview: review.preview } : {}),
        visual: input.draft,
      });
      if (revision?.kind !== input.draft.kind) return finishRepeat(input);
      const revised = { ...input, draft: revision, reviewRound: input.reviewRound + 1 };
      return revised.reviewRound >= config.visual.review.maxRounds
        ? finishRepeat(revised)
        : continueRepeatWith(revised);
    },
  });

  const reviewArtifactUntilDone = repeat({
    body: reviewArtifact,
    id: 'review-artifact-until-done',
    maxIterations: MAX_LESSON_VISUAL_REVIEW_ROUNDS,
    onExhausted: state => state,
    stateSchema: ArtifactReviewStateSchema,
  });

  const renderEmbeddedImage = step<
    typeof EmbeddedImageInputSchema,
    typeof EmbeddedImageOutputSchema,
    Config,
    Services
  >({
    externalEffect: 'provider-with-postprocessing',
    id: 'render-embedded-image',
    inputSchema: EmbeddedImageInputSchema,
    outputSchema: EmbeddedImageOutputSchema,
    run: async ({ config, execution, idempotencyKey, input, providerEffect, services, signal }) => {
      const image = await runDurableImageProvider(providerEffect, () =>
        services.generateEmbeddedImage({
          ...visualServiceInput(config, input.input, signal),
          request: input.request,
        })
      );
      const asset = await stageAsset({
        bytes: new Uint8Array(Buffer.from(image.data, 'base64')),
        execution,
        mediaType: image.mediaType,
        role: input.request.id,
        services,
        signal,
        stepInput: input.input,
        stepKey: idempotencyKey,
      });
      return { asset, id: input.request.id, nodeInstanceId: execution.nodeInstanceId };
    },
  });

  const materializeArtifact = fanOut({
    failureMode: 'fail-fast',
    fanIn: (results, state): LessonVisualWorkflowResult => {
      const completed = results.map(result => {
        if (result.status === 'failed') {
          throw failPermanently({
            code: 'lesson_visual_embedded_image_failed',
            message: 'A required lesson visual image could not be completed.',
          });
        }
        return result.output;
      });
      let code = state.draft.code;
      for (const image of completed) {
        code = code
          .split(`{{GENERATED_IMAGE:${image.id}}}`)
          .join(`{{PROJECT_ASSET:${image.asset.id}}}`);
      }
      if (code.includes('{{GENERATED_IMAGE:')) {
        throw failPermanently({
          code: 'lesson_visual_asset_placeholder_invalid',
          message: 'The lesson visual contains an unresolved image placeholder.',
        });
      }
      const retainedAssets = (state.input.existingEmbeddedAssets ?? []).filter(asset =>
        code.includes(buildProjectAssetPlaceholder(asset.id))
      );
      const embeddedAssets = [...retainedAssets, ...completed.map(image => image.asset)];
      if (
        state.draft.kind === 'html' &&
        !validateProjectAssetHtmlReferences(code, embeddedAssets).valid
      ) {
        throw failPermanently({
          code: 'lesson_visual_asset_placeholder_invalid',
          message: 'The lesson visual contains an invalid project asset placeholder.',
        });
      }
      const render: DurableProjectVisual =
        state.draft.kind === 'html'
          ? { code, embeddedAssets, kind: 'html' }
          : { code, kind: state.draft.kind };
      return buildResult({
        assetOwners: completed.map(image => ({
          assetIds: [image.asset.id],
          nodeInstanceId: image.nodeInstanceId,
        })),
        createdAt: state.createdAt,
        render,
        stepInput: state.input,
        visualId: state.visualId,
      });
    },
    id: 'materialize-artifact-images',
    inputSchema: ArtifactReviewStateSchema,
    inputs: state =>
      state.draft.kind === 'html'
        ? state.draft.imageRequests.map(request => ({ input: state.input, request }))
        : [],
    itemSchema: EmbeddedImageInputSchema,
    keyBy: input => input.request.id,
    outputSchema: LessonVisualWorkflowResultSchema,
    worker: renderEmbeddedImage,
  });

  const renderArtifact = sequence({
    id: 'render-artifact',
    nodes: [generateArtifact, reviewArtifactUntilDone, materializeArtifact] as const,
  });

  const renderWorkflow = workflow({
    compatibilityId: 'render-lesson-visual-v1',
    configSchema,
    executionDefaults,
    id: 'render-lesson-visual',
    inputSchema: LessonVisualWorkflowInputSchema,
    outputSchema: LessonVisualWorkflowResultSchema,
    root: routeBy({
      cases: { artifact: renderArtifact, raster: renderRaster },
      id: 'route-visual-format',
      inputSchema: LessonVisualWorkflowInputSchema,
      outputSchema: LessonVisualWorkflowResultSchema,
      select: input => (input.plan.visualType === 'illustrative_image' ? 'raster' : 'artifact'),
    }),
  });

  const persistRetryResult = step<
    typeof LessonVisualWorkflowResultSchema,
    typeof LessonVisualWorkflowResultSchema,
    Config,
    Services
  >({
    commit: ({ execution, input, services, transaction }) =>
      services.persistRetryResult({ execution, input, transaction }),
    id: 'persist-retry-result',
    inputSchema: LessonVisualWorkflowResultSchema,
    outputSchema: LessonVisualWorkflowResultSchema,
    run: async ({ input }) => input,
    undo: ({ execution, idempotencyKey, input, services, signal }) =>
      services.undoRetryResult({ execution, idempotencyKey, input, signal }),
  });

  const finalizeRetryResult = step<
    typeof LessonVisualWorkflowResultSchema,
    typeof LessonVisualRetryWorkflowResultSchema,
    Config,
    Services
  >({
    id: 'finalize-retry-result',
    inputSchema: LessonVisualWorkflowResultSchema,
    outputSchema: LessonVisualRetryWorkflowResultSchema,
    run: ({ execution, input, services }) => services.finalizeRetryResult({ execution, input }),
  });

  const publishProjectRevision = emit({
    event: LESSON_PROJECT_REVISION_EVENT,
    id: 'publish-project-revision',
    inputSchema: LessonVisualRetryWorkflowResultSchema,
    payload: result =>
      ProjectRevisionEventSchema.parse({
        projectId: result.target.projectId,
        revision: result.projectRevision,
      }),
  });

  const retryWorkflow = workflow({
    compatibilityId: 'retry-lesson-visual-v1',
    configSchema,
    executionDefaults,
    events: {
      [LESSON_PROJECT_REVISION_EVENT]: {
        durability: 'durable',
        schema: ProjectRevisionEventSchema,
        schemaVersion: PROJECT_REVISION_EVENT_SCHEMA_VERSION,
      },
    },
    id: LESSON_VISUAL_RETRY_WORKFLOW_ID,
    inputSchema: LessonVisualWorkflowInputSchema,
    outputSchema: LessonVisualRetryWorkflowResultSchema,
    root: sequence({
      id: 'root',
      nodes: [
        renderWorkflow,
        persistRetryResult,
        finalizeRetryResult,
        publishProjectRevision,
      ] as const,
    }),
  });

  return Object.freeze({ render: renderWorkflow, retry: retryWorkflow });
};
