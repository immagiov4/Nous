import type { TransactionSql } from 'postgres';
import * as z from 'zod';

import type { GlobalModelConfig, TextModelSlot } from '../config/modelConfig.js';
import {
  type CourseResearchServices,
  createCourseResearchNode,
} from './courseGenerationResearch.js';
import {
  type CourseDraftPlanState,
  CourseDraftPlanStateSchema,
  type CourseExercisesState,
  CourseExercisesStateSchema,
  type CourseGenerationStage,
  type CourseGenerationStageContext,
  type CourseGenerationWorkflowConfig,
  CourseGenerationWorkflowConfigSchema,
  type CourseGenerationWorkflowInput,
  CourseGenerationWorkflowInputSchema,
  type CourseGenerationWorkflowResult,
  CourseGenerationWorkflowResultSchema,
  type CoursePersistenceState,
  CoursePersistenceStateSchema,
  type CoursePlanState,
  CoursePlanStateSchema,
  type CoursePlanVerificationState,
  CoursePlanVerificationStateSchema,
  type CoursePreparationState,
  CoursePreparationStateSchema,
  type CourseRefinedPlanState,
  CourseRefinedPlanStateSchema,
  type CourseResearchState,
  CourseResearchStateSchema,
  type CourseSourcesFinalizedState,
  CourseSourcesFinalizedStateSchema,
  validateRefinedCoursePlan,
} from './courseGenerationWorkflowContract.js';
import {
  type CourseSourceFinalizationServices,
  createCourseSourceFinalizationNode,
} from './courseSourceFinalization.js';
import { emit, routeBy, sequence, step, workflow } from './definition.js';
import {
  COURSE_PROJECT_REVISION_EVENT,
  PROJECT_REVISION_EVENT_SCHEMA_VERSION,
  ProjectRevisionEventSchema,
} from './projectRevisionNotifications.js';
import { failPermanently, runWorkflowStage } from './retryPolicy.js';
import type { StepExecutionContext, WorkflowStepExecutionIdentity } from './types.js';
import { createWorkflowModelDiagnostic } from './workflowErrorDiagnostics.js';

export const COURSE_GENERATION_WORKFLOW_ID = 'course-generation';

export {
  type CourseGenerationStageContext,
  type CourseGenerationWorkflowConfig,
  CourseGenerationWorkflowConfigSchema,
} from './courseGenerationWorkflowContract.js';

export interface CourseGenerationWorkflowServices
  extends CourseResearchServices,
    CourseSourceFinalizationServices {
  readonly buildCoursePersistence: CourseGenerationStage<
    CourseExercisesState,
    CoursePersistenceState
  >;
  readonly draftCoursePlan: CourseGenerationStage<CourseResearchState, CourseDraftPlanState>;
  readonly finalizeCourse: CourseGenerationStage<
    CoursePersistenceState,
    CourseGenerationWorkflowResult
  >;
  readonly persistCourse: (input: {
    execution: WorkflowStepExecutionIdentity;
    input: CourseExercisesState;
    output: CoursePersistenceState;
    transaction: TransactionSql;
  }) => Promise<void>;
  readonly placeApplicationExercises: CourseGenerationStage<
    CourseSourcesFinalizedState,
    CourseExercisesState
  >;
  readonly prepareCourse: CourseGenerationStage<
    CourseGenerationWorkflowInput,
    CoursePreparationState
  >;
  readonly refineCoursePlan: CourseGenerationStage<
    CoursePlanVerificationState,
    CourseRefinedPlanState
  >;
  readonly undoCourse: (input: {
    execution: WorkflowStepExecutionIdentity;
    idempotencyKey: string;
    input: CourseExercisesState;
    output: CoursePersistenceState;
    signal: AbortSignal;
  }) => Promise<void>;
  readonly verifyCoursePlan: CourseGenerationStage<
    CourseDraftPlanState,
    CoursePlanVerificationState
  >;
}

interface StageFailure {
  readonly code: string;
  readonly message: string;
  readonly modelSlot?: TextModelSlot;
}

const runStage = async <Input, Output, Services extends CourseGenerationWorkflowServices>(
  context: StepExecutionContext<Input, CourseGenerationWorkflowConfig, Services>,
  failure: StageFailure,
  operation: (stage: CourseGenerationStageContext<Input>) => Promise<Output>
): Promise<Output> => {
  return runWorkflowStage({
    failure: {
      code: failure.code,
      message: failure.message,
      ...(failure.modelSlot
        ? {
            details: {
              model: createWorkflowModelDiagnostic(
                context.config.models as GlobalModelConfig,
                failure.modelSlot
              ),
            },
          }
        : {}),
    },
    operation: () => operation(context),
    signal: context.signal,
  });
};

// These schemas are part of the immediately previous durable manifest. Active runs may
// still hold its hash, so changing this shape would make those runs impossible to resume.
const PreviousCourseDraftPlanStateSchema = CourseResearchStateSchema.omit({ stage: true }).extend({
  plan: CoursePlanStateSchema.shape.plan,
  researchCoursePlan: CoursePlanStateSchema.shape.researchCoursePlan,
  stage: z.literal('plan'),
  syllabus: CoursePlanStateSchema.shape.syllabus,
});

type CoursePlanningTopology = 'current' | 'previous';

const withStageInput = <Input, NextInput>(
  stage: CourseGenerationStageContext<Input>,
  input: NextInput,
  operation: string
): CourseGenerationStageContext<NextInput> => ({
  attemptNumber: stage.attemptNumber,
  config: stage.config,
  execution: stage.execution,
  idempotencyKey: `${stage.idempotencyKey}:${operation}`,
  input,
  ...(stage.previousAttemptFailure ? { previousAttemptFailure: stage.previousAttemptFailure } : {}),
  retryFeedback: stage.retryFeedback,
  ...(stage.retryFeedbackSourceAttemptNumber === undefined
    ? {}
    : { retryFeedbackSourceAttemptNumber: stage.retryFeedbackSourceAttemptNumber }),
  signal: stage.signal,
});

const createCourseGenerationWorkflowDefinition = <
  Config extends CourseGenerationWorkflowConfig = CourseGenerationWorkflowConfig,
  Services extends CourseGenerationWorkflowServices = CourseGenerationWorkflowServices,
>(
  executionDefaults: Config,
  configSchema: z.ZodType<Config>,
  planningTopology: CoursePlanningTopology
) => {
  const prepareCourse = step<
    typeof CourseGenerationWorkflowInputSchema,
    typeof CoursePreparationStateSchema,
    Config,
    Services
  >({
    id: 'prepare-course',
    inputSchema: CourseGenerationWorkflowInputSchema,
    outputSchema: CoursePreparationStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'course_preparation_failed',
          message: 'The course generation context could not be prepared.',
        },
        stage => context.services.prepareCourse(stage)
      ),
  });

  const courseResearch = createCourseResearchNode<Config, Services>();

  const draftCoursePlan = step<
    typeof CourseResearchStateSchema,
    typeof CourseDraftPlanStateSchema,
    Config,
    Services
  >({
    externalEffect: 'provider',
    id: 'draft-course-plan',
    inputSchema: CourseResearchStateSchema,
    outputSchema: CourseDraftPlanStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'course_planning_failed',
          message: 'The course plan could not be generated.',
          modelSlot: 'course',
        },
        stage => context.services.draftCoursePlan(stage)
      ),
  });

  const verifyCoursePlan = step<
    typeof CourseDraftPlanStateSchema,
    typeof CoursePlanVerificationStateSchema,
    Config,
    Services
  >({
    externalEffect: 'provider',
    id: 'verify-course-plan',
    inputSchema: CourseDraftPlanStateSchema,
    outputSchema: CoursePlanVerificationStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'course_plan_verification_failed',
          message: 'The course plan could not be verified.',
          modelSlot: 'course',
        },
        stage => context.services.verifyCoursePlan(stage)
      ),
  });

  const refineCoursePlan = step<
    typeof CoursePlanVerificationStateSchema,
    typeof CourseRefinedPlanStateSchema,
    Config,
    Services
  >({
    externalEffect: 'provider-with-postprocessing',
    id: 'refine-course-plan',
    inputSchema: CoursePlanVerificationStateSchema,
    outputSchema: CourseRefinedPlanStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'course_refinement_failed',
          message: 'The course plan could not be refined.',
          modelSlot: 'course',
        },
        stage => context.services.refineCoursePlan(stage)
      ),
  });

  const validateCoursePlan = step<
    typeof CourseRefinedPlanStateSchema,
    typeof CoursePlanStateSchema,
    Config,
    Services
  >({
    id: 'validate-course-plan',
    inputSchema: CourseRefinedPlanStateSchema,
    outputSchema: CoursePlanStateSchema,
    run: async context => {
      try {
        return validateRefinedCoursePlan(context.input);
      } catch {
        throw failPermanently({
          code: 'course_plan_validation_failed',
          message: 'The refined course plan is invalid.',
        });
      }
    },
  });

  const runPreviousPlanningContract = async <Input>(
    context: StepExecutionContext<Input, CourseGenerationWorkflowConfig, Services>,
    researchState: CourseResearchState
  ): Promise<CoursePlanState> =>
    runStage(
      context,
      {
        code: 'course_planning_failed',
        message: 'The course plan could not be generated.',
        modelSlot: 'course',
      },
      async stage => {
        const draft = await context.services.draftCoursePlan(
          withStageInput(stage, researchState, 'draft')
        );
        const verified = await context.services.verifyCoursePlan(
          withStageInput(stage, draft, 'verify')
        );
        const refined = await context.services.refineCoursePlan(
          withStageInput(stage, verified, 'refine')
        );
        try {
          return validateRefinedCoursePlan(refined);
        } catch {
          throw failPermanently({
            code: 'course_plan_validation_failed',
            message: 'The refined course plan is invalid.',
          });
        }
      }
    );

  const previousPlanningStep = (id: string) =>
    step<typeof CourseResearchStateSchema, typeof CoursePlanStateSchema, Config, Services>({
      externalEffect: 'provider',
      id,
      inputSchema: CourseResearchStateSchema,
      outputSchema: CoursePlanStateSchema,
      run: context => runPreviousPlanningContract(context, context.input),
    });

  const previousDraftPlanningStep = (id: string) =>
    step<
      typeof CourseResearchStateSchema,
      typeof PreviousCourseDraftPlanStateSchema,
      Config,
      Services
    >({
      externalEffect: 'provider',
      id,
      inputSchema: CourseResearchStateSchema,
      outputSchema: PreviousCourseDraftPlanStateSchema,
      run: context =>
        runStage(
          context,
          {
            code: 'course_planning_failed',
            message: 'The course plan could not be generated.',
            modelSlot: 'course',
          },
          async stage => {
            const draft = await context.services.draftCoursePlan(
              withStageInput(stage, context.input, 'draft')
            );
            return PreviousCourseDraftPlanStateSchema.parse({ ...draft, stage: 'plan' });
          }
        ),
    });

  const previousRefinementStep = (id: string) =>
    step<typeof PreviousCourseDraftPlanStateSchema, typeof CoursePlanStateSchema, Config, Services>(
      {
        externalEffect: 'provider',
        id,
        inputSchema: PreviousCourseDraftPlanStateSchema,
        outputSchema: CoursePlanStateSchema,
        run: context => {
          const researchState = CourseResearchStateSchema.parse({
            ...context.input,
            stage: 'research',
          });
          return runPreviousPlanningContract(context, researchState);
        },
      }
    );

  const previousRouteCoursePlanning = routeBy({
    cases: {
      archive: sequence({
        id: 'plan-archive-course',
        nodes: [
          previousDraftPlanningStep('draft-archive-course'),
          previousRefinementStep('refine-archive-course'),
        ] as const,
      }),
      learn: previousPlanningStep('plan-learn-course'),
      'single-source': sequence({
        id: 'plan-single-source-course',
        nodes: [
          previousDraftPlanningStep('draft-source-course'),
          previousRefinementStep('refine-source-course'),
        ] as const,
      }),
      'source-set': previousPlanningStep('plan-source-set-course'),
    },
    id: 'route-course-planning',
    inputSchema: CourseResearchStateSchema,
    outputSchema: CoursePlanStateSchema,
    select: input => input.strategy,
  });

  const finalizeCourseSources = createCourseSourceFinalizationNode<Config, Services>();

  const placeApplicationExercises = step<
    typeof CourseSourcesFinalizedStateSchema,
    typeof CourseExercisesStateSchema,
    Config,
    Services
  >({
    externalEffect: 'provider',
    id: 'place-application-exercises',
    inputSchema: CourseSourcesFinalizedStateSchema,
    outputSchema: CourseExercisesStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'course_exercise_planning_failed',
          message: 'The course exercises could not be planned.',
          modelSlot: 'course',
        },
        stage => context.services.placeApplicationExercises(stage)
      ),
  });

  const persistCourse = step<
    typeof CourseExercisesStateSchema,
    typeof CoursePersistenceStateSchema,
    Config,
    Services
  >({
    commit: ({ execution, input, output, services, transaction }) =>
      services.persistCourse({ execution, input, output, transaction }),
    id: 'persist-course',
    inputSchema: CourseExercisesStateSchema,
    outputSchema: CoursePersistenceStateSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'course_persistence_failed',
          message: 'The course could not be prepared for saving.',
        },
        stage => context.services.buildCoursePersistence(stage)
      ),
    undo: ({ execution, idempotencyKey, input, output, services, signal }) =>
      services.undoCourse({ execution, idempotencyKey, input, output, signal }),
  });

  const returnGeneratedCourse = step<
    typeof CoursePersistenceStateSchema,
    typeof CourseGenerationWorkflowResultSchema,
    Config,
    Services
  >({
    id: 'return-generated-course',
    inputSchema: CoursePersistenceStateSchema,
    outputSchema: CourseGenerationWorkflowResultSchema,
    run: context =>
      runStage(
        context,
        {
          code: 'course_finalization_failed',
          message: 'The saved course could not be finalized.',
        },
        stage => context.services.finalizeCourse(stage)
      ),
  });

  const publishCourseProjectRevision = emit({
    event: COURSE_PROJECT_REVISION_EVENT,
    id: 'publish-course-project-revision',
    inputSchema: CourseGenerationWorkflowResultSchema,
    payload: result =>
      ProjectRevisionEventSchema.parse({
        projectId: result.projectId,
        revision: result.projectRevision,
      }),
  });

  const root =
    planningTopology === 'current'
      ? sequence({
          id: COURSE_GENERATION_WORKFLOW_ID,
          nodes: [
            prepareCourse,
            courseResearch,
            draftCoursePlan,
            verifyCoursePlan,
            refineCoursePlan,
            validateCoursePlan,
            finalizeCourseSources,
            placeApplicationExercises,
            persistCourse,
            returnGeneratedCourse,
            publishCourseProjectRevision,
          ] as const,
        })
      : sequence({
          id: COURSE_GENERATION_WORKFLOW_ID,
          nodes: [
            prepareCourse,
            courseResearch,
            previousRouteCoursePlanning,
            finalizeCourseSources,
            placeApplicationExercises,
            persistCourse,
            returnGeneratedCourse,
            publishCourseProjectRevision,
          ] as const,
        });

  return workflow({
    compatibilityId: 'course-generation-v1',
    configSchema,
    executionDefaults,
    events: {
      [COURSE_PROJECT_REVISION_EVENT]: {
        durability: 'durable',
        schema: ProjectRevisionEventSchema,
        schemaVersion: PROJECT_REVISION_EVENT_SCHEMA_VERSION,
      },
    },
    id: COURSE_GENERATION_WORKFLOW_ID,
    inputSchema: CourseGenerationWorkflowInputSchema,
    outputSchema: CourseGenerationWorkflowResultSchema,
    root,
  });
};

export const createCourseGenerationWorkflow = <
  Config extends CourseGenerationWorkflowConfig = CourseGenerationWorkflowConfig,
  Services extends CourseGenerationWorkflowServices = CourseGenerationWorkflowServices,
>(
  executionDefaults: Config,
  configSchema: z.ZodType<Config> = CourseGenerationWorkflowConfigSchema as z.ZodType<Config>
) =>
  createCourseGenerationWorkflowDefinition<Config, Services>(
    executionDefaults,
    configSchema,
    'current'
  );

export const createPreviousCourseGenerationWorkflow = <
  Config extends CourseGenerationWorkflowConfig = CourseGenerationWorkflowConfig,
  Services extends CourseGenerationWorkflowServices = CourseGenerationWorkflowServices,
>(
  executionDefaults: Config,
  configSchema: z.ZodType<Config> = CourseGenerationWorkflowConfigSchema as z.ZodType<Config>
) =>
  createCourseGenerationWorkflowDefinition<Config, Services>(
    executionDefaults,
    configSchema,
    'previous'
  );
