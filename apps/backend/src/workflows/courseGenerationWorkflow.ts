import type { TransactionSql } from 'postgres';
import type * as z from 'zod';

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
  type CoursePreparationState,
  CoursePreparationStateSchema,
  type CourseResearchState,
  CourseResearchStateSchema,
  type CourseSourcesFinalizedState,
  CourseSourcesFinalizedStateSchema,
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
import { runWorkflowStage } from './retryPolicy.js';
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
  readonly draftArchiveCourse: CourseGenerationStage<CourseResearchState, CourseDraftPlanState>;
  readonly draftSourceCourse: CourseGenerationStage<CourseResearchState, CourseDraftPlanState>;
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
  readonly planLearnCourse: CourseGenerationStage<CourseResearchState, CoursePlanState>;
  readonly planSourceSetCourse: CourseGenerationStage<CourseResearchState, CoursePlanState>;
  readonly prepareCourse: CourseGenerationStage<
    CourseGenerationWorkflowInput,
    CoursePreparationState
  >;
  readonly refineArchiveCourse: CourseGenerationStage<CourseDraftPlanState, CoursePlanState>;
  readonly refineSourceCourse: CourseGenerationStage<CourseDraftPlanState, CoursePlanState>;
  readonly undoCourse: (input: {
    execution: WorkflowStepExecutionIdentity;
    idempotencyKey: string;
    input: CourseExercisesState;
    output: CoursePersistenceState;
    signal: AbortSignal;
  }) => Promise<void>;
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

export const createCourseGenerationWorkflow = <
  Config extends CourseGenerationWorkflowConfig = CourseGenerationWorkflowConfig,
  Services extends CourseGenerationWorkflowServices = CourseGenerationWorkflowServices,
>(
  executionDefaults: Config,
  configSchema: z.ZodType<Config> = CourseGenerationWorkflowConfigSchema as z.ZodType<Config>
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

  const planningStep = (
    id: string,
    operation: (
      services: Services,
      stage: CourseGenerationStageContext<CourseResearchState>
    ) => Promise<CoursePlanState>
  ) =>
    step<typeof CourseResearchStateSchema, typeof CoursePlanStateSchema, Config, Services>({
      id,
      inputSchema: CourseResearchStateSchema,
      outputSchema: CoursePlanStateSchema,
      run: context =>
        runStage(
          context,
          {
            code: 'course_planning_failed',
            message: 'The course plan could not be generated.',
            modelSlot: 'course',
          },
          stage => operation(context.services, stage)
        ),
    });

  const draftPlanningStep = (
    id: string,
    operation: (
      services: Services,
      stage: CourseGenerationStageContext<CourseResearchState>
    ) => Promise<CourseDraftPlanState>
  ) =>
    step<typeof CourseResearchStateSchema, typeof CourseDraftPlanStateSchema, Config, Services>({
      id,
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
          stage => operation(context.services, stage)
        ),
    });

  const refinementStep = (
    id: string,
    operation: (
      services: Services,
      stage: CourseGenerationStageContext<CourseDraftPlanState>
    ) => Promise<CoursePlanState>
  ) =>
    step<typeof CourseDraftPlanStateSchema, typeof CoursePlanStateSchema, Config, Services>({
      id,
      inputSchema: CourseDraftPlanStateSchema,
      outputSchema: CoursePlanStateSchema,
      run: context =>
        runStage(
          context,
          {
            code: 'course_refinement_failed',
            message: 'The course plan could not be refined.',
            modelSlot: 'course',
          },
          stage => operation(context.services, stage)
        ),
    });

  const planLearnCourse = planningStep('plan-learn-course', (services, stage) =>
    services.planLearnCourse(stage)
  );
  const draftSourceCourse = draftPlanningStep('draft-source-course', (services, stage) =>
    services.draftSourceCourse(stage)
  );
  const refineSourceCourse = refinementStep('refine-source-course', (services, stage) =>
    services.refineSourceCourse(stage)
  );
  const planSourceSetCourse = planningStep('plan-source-set-course', (services, stage) =>
    services.planSourceSetCourse(stage)
  );
  const draftArchiveCourse = draftPlanningStep('draft-archive-course', (services, stage) =>
    services.draftArchiveCourse(stage)
  );
  const refineArchiveCourse = refinementStep('refine-archive-course', (services, stage) =>
    services.refineArchiveCourse(stage)
  );

  const routeCoursePlanning = routeBy({
    cases: {
      archive: sequence({
        id: 'plan-archive-course',
        nodes: [draftArchiveCourse, refineArchiveCourse] as const,
      }),
      learn: planLearnCourse,
      'single-source': sequence({
        id: 'plan-single-source-course',
        nodes: [draftSourceCourse, refineSourceCourse] as const,
      }),
      'source-set': planSourceSetCourse,
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
    root: sequence({
      id: COURSE_GENERATION_WORKFLOW_ID,
      nodes: [
        prepareCourse,
        courseResearch,
        routeCoursePlanning,
        finalizeCourseSources,
        placeApplicationExercises,
        persistCourse,
        returnGeneratedCourse,
        publishCourseProjectRevision,
      ] as const,
    }),
  });
};
