import { ARTIFACT_DRAFT_SLOT_ID } from '@shared/artifactDraftWorkflowContract';
import * as z from 'zod';
import type { ProjectAssetWriter } from '../projects/projectAsset.js';
import {
  isInvalidLessonVisualStructuredOutput,
  type LessonVisualRetryPlan,
  type PlanLessonArtifactDraftInput,
} from '../services/lessonGenerationVisuals.js';
import {
  type LessonVisualModelConfig,
  LessonVisualModelConfigSchema,
} from '../services/lessonVisualModelConfig.js';

import { WorkflowExecutionDefaultsSchema } from './config.js';
import { routeBy, sequence, step, workflow } from './definition.js';
import { ProjectLessonVisualSchema } from './lessonGenerationWorkflowSchemas.js';
import { buildLessonVisualContextFingerprint } from './lessonVisualContext.js';
import {
  createLessonVisualWorkflows,
  LessonVisualWorkflowInputSchema,
  LessonVisualWorkflowResultSchema,
  type LessonVisualWorkflowServices,
} from './lessonVisualWorkflow.js';
import { retryCorrective, runWorkflowStage } from './retryPolicy.js';
import type { WorkflowExecutionDefaults } from './types.js';

export { ARTIFACT_DRAFT_SLOT_ID };

export const ARTIFACT_DRAFT_WORKFLOW_ID = 'lesson-artifact-draft';

export const ArtifactDraftWorkflowInputSchema = z.object({
  generationNotes: z.string().optional(),
  lessonMarkdown: z.string().min(1),
  projectId: z.string().min(1),
  requestText: z.string().min(1),
  requestedVisualKind: z.enum(['html', 'image', 'mermaid', 'svg']).optional(),
  sectionDescription: z.string(),
  sectionId: z.string().min(1),
  sectionTitle: z.string().min(1),
  sourceVisual: ProjectLessonVisualSchema.optional(),
  userId: z.string().min(1),
});

export const ArtifactDraftWorkflowResultSchema = z.object({
  visual: ProjectLessonVisualSchema.nullable(),
});

const ArtifactDraftWorkflowConfigSchema = WorkflowExecutionDefaultsSchema.extend({
  visual: LessonVisualModelConfigSchema,
});

export type ArtifactDraftWorkflowConfig = WorkflowExecutionDefaults & {
  readonly visual: LessonVisualModelConfig;
};
export type ArtifactDraftWorkflowInput = z.infer<typeof ArtifactDraftWorkflowInputSchema>;

type ArtifactDraftAssets = LessonVisualWorkflowServices['assets'] &
  Pick<ProjectAssetWriter, 'adoptNodeAssets'>;

export type ArtifactDraftWorkflowServices = Omit<LessonVisualWorkflowServices, 'assets'> & {
  readonly assets: ArtifactDraftAssets;
  readonly planArtifactDraft: (
    input: PlanLessonArtifactDraftInput
  ) => Promise<LessonVisualRetryPlan | null>;
};

const NoArtifactDraftSchema = z.object({
  kind: z.literal('none'),
  projectId: z.string().min(1),
  sectionId: z.string().min(1),
  userId: z.string().min(1),
});

const RenderArtifactDraftSchema = LessonVisualWorkflowInputSchema.extend({
  kind: z.literal('render'),
});

const ArtifactDraftPlanStateSchema = z.discriminatedUnion('kind', [
  NoArtifactDraftSchema,
  RenderArtifactDraftSchema,
]);

const ArtifactDraftRenderStateSchema = z.union([
  NoArtifactDraftSchema,
  LessonVisualWorkflowResultSchema,
]);

type ArtifactDraftPlanState = z.infer<typeof ArtifactDraftPlanStateSchema>;

const explicitRasterPlan = (input: ArtifactDraftWorkflowInput): LessonVisualRetryPlan => {
  const subject = input.requestText.trim();
  const altText = input.sectionDescription.trim() || input.sectionTitle;
  return {
    altText,
    complexity: 'simple',
    concept: subject,
    coverage: 'complete_synthesis',
    coverageRationale: 'Il formato visuale è stato richiesto esplicitamente dall’utente.',
    factualRequirements: [],
    interactionLevel: 'none',
    pedagogicalGoal: 'Costruire un riferimento visivo concreto.',
    reason: 'Il tipo visuale è stato richiesto esplicitamente.',
    requiresDepiction: true,
    slotId: ARTIFACT_DRAFT_SLOT_ID,
    title: input.sectionTitle,
    visualDirection: '',
    visualType: 'illustrative_image',
  };
};

const planWithModel = async (
  input: ArtifactDraftWorkflowInput,
  config: ArtifactDraftWorkflowConfig,
  services: ArtifactDraftWorkflowServices,
  signal: AbortSignal,
  retryFeedback: string
): Promise<LessonVisualRetryPlan | null> => {
  return runWorkflowStage({
    failure: {
      code: 'artifact_draft_planning_failed',
      message: 'The artifact draft could not be planned.',
    },
    operation: async () => {
      try {
        return await services.planArtifactDraft({
          config: config.visual,
          generationNotes: input.generationNotes,
          lessonMarkdown: input.lessonMarkdown,
          requestedVisualKind: input.requestedVisualKind,
          retryFeedback,
          sectionDescription: input.sectionDescription,
          sectionTitle: input.sectionTitle,
          signal,
          slotId: ARTIFACT_DRAFT_SLOT_ID,
        });
      } catch (error) {
        if (isInvalidLessonVisualStructuredOutput(error)) {
          throw retryCorrective({
            code: 'artifact_draft_plan_invalid',
            feedback: 'Return one valid visual plan that exactly matches the requested schema.',
            message: 'The artifact draft planner returned invalid structured output.',
          });
        }
        throw error;
      }
    },
    signal,
  });
};

const renderState = (
  input: ArtifactDraftWorkflowInput,
  plan: LessonVisualRetryPlan
): z.infer<typeof RenderArtifactDraftSchema> => ({
  contextFingerprint: buildLessonVisualContextFingerprint(input),
  ...(input.sourceVisual?.render.kind === 'html'
    ? { existingEmbeddedAssets: [...input.sourceVisual.render.embeddedAssets] }
    : {}),
  kind: 'render',
  lessonMarkdown: input.lessonMarkdown,
  plan,
  projectId: input.projectId,
  sectionDescription: input.sectionDescription,
  sectionId: input.sectionId,
  sectionTitle: input.sectionTitle,
  userId: input.userId,
});

export const createArtifactDraftWorkflow = (executionDefaults: ArtifactDraftWorkflowConfig) => {
  const visualWorkflow = createLessonVisualWorkflows<
    ArtifactDraftWorkflowConfig,
    ArtifactDraftWorkflowServices
  >(executionDefaults, ArtifactDraftWorkflowConfigSchema).render;

  const planArtifactDraft = step<
    typeof ArtifactDraftWorkflowInputSchema,
    typeof ArtifactDraftPlanStateSchema,
    ArtifactDraftWorkflowConfig,
    ArtifactDraftWorkflowServices
  >({
    externalEffect: 'provider',
    id: 'plan-artifact-draft',
    inputSchema: ArtifactDraftWorkflowInputSchema,
    outputSchema: ArtifactDraftPlanStateSchema,
    run: async ({ config, input, retryFeedback, services, signal }) => {
      const plan =
        input.requestedVisualKind === 'image'
          ? explicitRasterPlan(input)
          : await planWithModel(input, config, services, signal, retryFeedback);
      return plan
        ? renderState(input, plan)
        : {
            kind: 'none',
            projectId: input.projectId,
            sectionId: input.sectionId,
            userId: input.userId,
          };
    },
  });

  const returnNoArtifact = step<
    typeof ArtifactDraftPlanStateSchema,
    typeof ArtifactDraftRenderStateSchema,
    ArtifactDraftWorkflowConfig,
    ArtifactDraftWorkflowServices
  >({
    id: 'return-no-artifact-draft',
    inputSchema: ArtifactDraftPlanStateSchema,
    outputSchema: ArtifactDraftRenderStateSchema,
    run: async ({ input }) => {
      if (input.kind !== 'none') throw new TypeError('Expected an empty artifact draft plan.');
      return input;
    },
  });

  const requireRenderInput = step<
    typeof ArtifactDraftPlanStateSchema,
    typeof LessonVisualWorkflowInputSchema,
    ArtifactDraftWorkflowConfig,
    ArtifactDraftWorkflowServices
  >({
    id: 'require-artifact-render-input',
    inputSchema: ArtifactDraftPlanStateSchema,
    outputSchema: LessonVisualWorkflowInputSchema,
    run: async ({ input }) => {
      if (input.kind !== 'render') throw new TypeError('Expected an artifact render plan.');
      return input;
    },
  });

  const returnRenderedArtifact = step<
    typeof LessonVisualWorkflowResultSchema,
    typeof ArtifactDraftRenderStateSchema,
    ArtifactDraftWorkflowConfig,
    ArtifactDraftWorkflowServices
  >({
    id: 'return-rendered-artifact-draft',
    inputSchema: LessonVisualWorkflowResultSchema,
    outputSchema: ArtifactDraftRenderStateSchema,
    run: async ({ input }) => input,
  });

  const renderArtifactDraft = sequence({
    id: 'render-artifact-draft',
    nodes: [requireRenderInput, visualWorkflow, returnRenderedArtifact] as const,
  });

  const chooseArtifactDraft = routeBy({
    cases: { none: returnNoArtifact, render: renderArtifactDraft },
    id: 'route-artifact-draft',
    inputSchema: ArtifactDraftPlanStateSchema,
    outputSchema: ArtifactDraftRenderStateSchema,
    select: (state: ArtifactDraftPlanState) => state.kind,
  });

  const adoptArtifactDraftAssets = step<
    typeof ArtifactDraftRenderStateSchema,
    typeof ArtifactDraftWorkflowResultSchema,
    ArtifactDraftWorkflowConfig,
    ArtifactDraftWorkflowServices
  >({
    commit: async ({ execution, input, services, transaction }) => {
      if (!('visual' in input)) return;
      for (const owner of input.assetOwners) {
        await services.assets.adoptNodeAssets(transaction, {
          assetIds: owner.assetIds,
          nodeInstanceId: owner.nodeInstanceId,
          projectId: input.target.projectId,
          runId: execution.runId,
          userId: input.target.userId,
        });
      }
    },
    id: 'adopt-artifact-draft-assets',
    inputSchema: ArtifactDraftRenderStateSchema,
    outputSchema: ArtifactDraftWorkflowResultSchema,
    run: async ({ input }) => ({ visual: 'visual' in input ? input.visual : null }),
  });

  return workflow({
    compatibilityId: 'lesson-artifact-draft-v1',
    configSchema: ArtifactDraftWorkflowConfigSchema,
    executionDefaults,
    id: ARTIFACT_DRAFT_WORKFLOW_ID,
    inputSchema: ArtifactDraftWorkflowInputSchema,
    outputSchema: ArtifactDraftWorkflowResultSchema,
    root: sequence({
      id: 'artifact-draft-flow',
      nodes: [planArtifactDraft, chooseArtifactDraft, adoptArtifactDraftAssets] as const,
    }),
  });
};
