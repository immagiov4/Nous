import {
  getPdfMappingRepairState,
  needsPdfMappingRepair,
  type PdfMappingRepairResult,
} from '@shared/pdfMappingRepairContract.js';
import * as z from 'zod';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import { getProjectStore } from '../projects/projectStore.js';
import { patchProjectInTransaction } from '../projects/projectTransaction.js';
import type {
  LearningPlanNodeSnapshot,
  LearningPlanSnapshot,
  ProjectPatch,
  ProjectSnapshot,
  ProjectStore,
} from '../projects/types.js';
import { timestampIso } from '../utils/time.js';
import { isRecord } from '../utils/validation.js';
import { createCoursePreparationStage } from './courseGenerationPreparation.js';
import type {
  CourseGenerationStage,
  CourseGenerationStageContext,
  CourseGenerationWorkflowConfig,
  CourseGenerationWorkflowInput,
  CoursePreparationState,
} from './courseGenerationWorkflowContract.js';
import {
  CourseGenerationWorkflowConfigSchema,
  CourseLearningPlanSchema,
  CoursePlanStateSchema,
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
import { failPermanently, retryOperational, runWorkflowStage } from './retryPolicy.js';
import type { StepCommitContext, StepExecutionContext } from './types.js';
import { createWorkflowModelDiagnostic } from './workflowErrorDiagnostics.js';

export const PDF_MAPPING_REPAIR_WORKFLOW_ID = 'pdf-mapping-repair';

export const PdfMappingRepairWorkflowInputSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
});

export const PdfMappingRepairResultSchema = z.object({
  projectId: z.string().min(1),
  projectRevision: z.number().int().nonnegative(),
  repaired: z.boolean(),
});

const PdfMappingRepairPreparationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), result: PdfMappingRepairResultSchema }),
  z.object({ kind: z.literal('repair'), state: CoursePlanStateSchema }),
]);

export type PdfMappingRepairWorkflowInput = z.infer<typeof PdfMappingRepairWorkflowInputSchema>;
type PdfMappingRepairPreparation = z.infer<typeof PdfMappingRepairPreparationSchema>;

export interface PdfMappingRepairWorkflowServices extends CourseSourceFinalizationServices {
  readonly persistPdfMappingRepair: (
    input: StepCommitContext<
      z.infer<typeof CourseSourcesFinalizedStateSchema>,
      PdfMappingRepairResult,
      CourseGenerationWorkflowConfig,
      PdfMappingRepairWorkflowServices
    >
  ) => Promise<void>;
  readonly preparePdfMappingRepair: CourseGenerationStage<
    PdfMappingRepairWorkflowInput,
    PdfMappingRepairPreparation
  >;
}

type PdfMappingRepairOwnServices = Pick<
  PdfMappingRepairWorkflowServices,
  'persistPdfMappingRepair' | 'preparePdfMappingRepair'
>;

export class PdfMappingRepairTargetChangedError extends Error {
  constructor() {
    super('The PDF mapping repair target is no longer authoritative.');
    this.name = 'PdfMappingRepairTargetChangedError';
  }
}

const isPdfSource = (source: unknown): boolean => isRecord(source) && source.kind === 'pdf';

const selectRepairLesson = (node: LearningPlanNodeSnapshot) =>
  node.kind === 'exercise' ? [] : [{ ...node, kind: 'lesson' as const }];

const shouldUseModuleLessons = (plan: LearningPlanSnapshot): boolean => {
  const hasModuleLessons = plan.modules?.some(module =>
    module.children?.some(node => node.kind !== 'exercise')
  );
  const hasLegacyLessons = plan.sections?.some(node => node.kind !== 'exercise');
  return Boolean(hasModuleLessons || !hasLegacyLessons);
};

const normalizeRepairPlan = (plan: LearningPlanSnapshot | null | undefined): unknown => {
  if (!plan) return plan;
  const title = typeof plan.title === 'string' && plan.title.trim() ? plan.title : 'Percorso';
  const summary = typeof plan.summary === 'string' && plan.summary.trim() ? plan.summary : title;
  const modules = Array.isArray(plan.modules)
    ? plan.modules.map(module => ({
        ...module,
        children: (module.children ?? []).flatMap(selectRepairLesson),
      }))
    : [];
  const legacyLessons = Array.isArray(plan.sections)
    ? plan.sections.flatMap(selectRepairLesson)
    : [];
  const repairModules = shouldUseModuleLessons(plan)
    ? modules
    : [{ children: legacyLessons, id: 'legacy-sections', title }];
  return {
    ...plan,
    applicationExercisePlanningStatus: plan.applicationExercisePlanningStatus ?? 'not-run',
    modules: repairModules,
    summary,
    title,
  };
};

export const getProjectPdfMappingRepairState = (snapshot: ProjectSnapshot) =>
  getPdfMappingRepairState({
    documentIndex: isRecord(snapshot.documentIndex) ? snapshot.documentIndex : null,
    isPdf: isPdfSource(snapshot.source),
    plan: snapshot.learningPlan,
  });

export const createPdfMappingRepairPreparationStage =
  ({
    loadProjectWithRevision,
    prepareCourse,
  }: {
    readonly loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
    readonly prepareCourse: CourseGenerationStage<
      CourseGenerationWorkflowInput,
      CoursePreparationState
    >;
  }): PdfMappingRepairWorkflowServices['preparePdfMappingRepair'] =>
  async context => {
    const project = await loadProjectWithRevision(context.input.userId, context.input.projectId);
    if (!project) {
      throw failPermanently({
        code: 'pdf_mapping_project_missing',
        message: 'The PDF mapping project no longer exists.',
      });
    }
    const repairState = getProjectPdfMappingRepairState(project.snapshot);
    if (!needsPdfMappingRepair(repairState)) {
      return {
        kind: 'ready',
        result: {
          projectId: context.input.projectId,
          projectRevision: project.revision,
          repaired: false,
        },
      };
    }

    const prepared = await prepareCourse({
      ...context,
      input: {
        assessmentHistory: [],
        mode: 'document',
        projectId: context.input.projectId,
        userId: context.input.userId,
      },
    });
    if (project.revision !== prepared.projectRevision) {
      throw retryOperational({
        code: 'pdf_mapping_project_changed',
        message: 'The PDF mapping project changed while repair was being prepared.',
      });
    }

    const plan = CourseLearningPlanSchema.safeParse(
      normalizeRepairPlan(project.snapshot.learningPlan)
    );
    if (!plan.success) {
      throw failPermanently({
        code: 'pdf_mapping_plan_invalid',
        message: 'The stored course plan cannot be repaired.',
      });
    }
    return {
      kind: 'repair',
      state: CoursePlanStateSchema.parse({
        ...prepared,
        plan: plan.data,
        researchCoursePlan: null,
        stage: 'plan',
        syllabus: [],
      }),
    };
  };

type LockedProject = { revision: number; snapshot: ProjectSnapshot };
type RepairPatch = Omit<ProjectPatch, 'updatedAt'>;

const collectLessonMappings = (plan: z.infer<typeof CourseLearningPlanSchema>) =>
  new Map(
    plan.modules.flatMap(module =>
      module.children.flatMap(child =>
        child.kind === 'lesson' && child.primaryChunkIds?.length
          ? [
              [
                child.id,
                {
                  primaryChunkIds: child.primaryChunkIds,
                  primaryChunkMappingSource: child.primaryChunkMappingSource,
                  sourceReferences: child.sourceReferences,
                },
              ] as const,
            ]
          : []
      )
    )
  );

const applyLessonMappings = (
  storedPlan: LearningPlanSnapshot,
  mappedPlan: z.infer<typeof CourseLearningPlanSchema>
): LearningPlanSnapshot => {
  const mappings = collectLessonMappings(mappedPlan);
  const applyMapping = (node: LearningPlanNodeSnapshot): LearningPlanNodeSnapshot => {
    const mapping = node.id ? mappings.get(node.id) : undefined;
    return mapping ? { ...node, ...mapping } : node;
  };
  if (shouldUseModuleLessons(storedPlan) && Array.isArray(storedPlan.modules)) {
    return {
      ...storedPlan,
      modules: storedPlan.modules.map(module => ({
        ...module,
        children: module.children?.map(applyMapping),
      })),
    };
  }
  if (Array.isArray(storedPlan.sections)) {
    return { ...storedPlan, sections: storedPlan.sections.map(applyMapping) };
  }
  throw new PdfMappingRepairTargetChangedError();
};

export const buildPdfMappingRepairCommitPatch = (
  project: LockedProject,
  input: z.infer<typeof CourseSourcesFinalizedStateSchema>,
  output: PdfMappingRepairResult
): RepairPatch => {
  if (
    !input.documentIndex ||
    project.snapshot.id !== output.projectId ||
    project.revision !== input.projectRevision ||
    output.projectId !== input.request.projectId ||
    output.projectRevision !== project.revision + 1 ||
    !output.repaired
  ) {
    throw new PdfMappingRepairTargetChangedError();
  }
  const storedPlan = project.snapshot.learningPlan;
  if (!storedPlan) throw new PdfMappingRepairTargetChangedError();
  return {
    documentIndex: input.documentIndex,
    learningPlan: applyLessonMappings(storedPlan, input.plan),
  };
};

const runRepairStage = <Input, Output>(
  context: StepExecutionContext<
    Input,
    CourseGenerationWorkflowConfig,
    PdfMappingRepairWorkflowServices
  >,
  operation: (stage: CourseGenerationStageContext<Input>) => Promise<Output>
): Promise<Output> =>
  runWorkflowStage({
    failure: {
      code: 'pdf_mapping_repair_failed',
      details: {
        model: createWorkflowModelDiagnostic(context.config.models as GlobalModelConfig, 'course'),
      },
      message: 'The PDF mapping could not be repaired.',
    },
    operation: () => operation(context),
    signal: context.signal,
  });

export const createPdfMappingRepairWorkflow = (
  executionDefaults: CourseGenerationWorkflowConfig,
  configSchema: z.ZodType<CourseGenerationWorkflowConfig> = CourseGenerationWorkflowConfigSchema
) => {
  const prepareRepair = step<
    typeof PdfMappingRepairWorkflowInputSchema,
    typeof PdfMappingRepairPreparationSchema,
    CourseGenerationWorkflowConfig,
    PdfMappingRepairWorkflowServices
  >({
    id: 'prepare-pdf-mapping-repair',
    inputSchema: PdfMappingRepairWorkflowInputSchema,
    outputSchema: PdfMappingRepairPreparationSchema,
    run: context =>
      runRepairStage(context, stage => context.services.preparePdfMappingRepair(stage)),
  });

  const returnReady = step<
    typeof PdfMappingRepairPreparationSchema,
    typeof PdfMappingRepairResultSchema,
    CourseGenerationWorkflowConfig,
    PdfMappingRepairWorkflowServices
  >({
    id: 'return-ready-pdf-mapping',
    inputSchema: PdfMappingRepairPreparationSchema,
    outputSchema: PdfMappingRepairResultSchema,
    run: async context => {
      if (context.input.kind !== 'ready') {
        throw new Error('PDF mapping repair expected an already-ready project.');
      }
      return context.input.result;
    },
  });

  const selectRepairState = step<
    typeof PdfMappingRepairPreparationSchema,
    typeof CoursePlanStateSchema,
    CourseGenerationWorkflowConfig,
    PdfMappingRepairWorkflowServices
  >({
    id: 'select-pdf-mapping-repair-state',
    inputSchema: PdfMappingRepairPreparationSchema,
    outputSchema: CoursePlanStateSchema,
    run: async context => {
      if (context.input.kind !== 'repair') {
        throw new Error('PDF mapping repair expected a repairable project.');
      }
      return context.input.state;
    },
  });

  const finalizeSources = createCourseSourceFinalizationNode<
    CourseGenerationWorkflowConfig,
    PdfMappingRepairWorkflowServices
  >();

  const persistRepair = step<
    typeof CourseSourcesFinalizedStateSchema,
    typeof PdfMappingRepairResultSchema,
    CourseGenerationWorkflowConfig,
    PdfMappingRepairWorkflowServices
  >({
    commit: context => context.services.persistPdfMappingRepair(context),
    id: 'persist-pdf-mapping-repair',
    inputSchema: CourseSourcesFinalizedStateSchema,
    outputSchema: PdfMappingRepairResultSchema,
    run: async context => ({
      projectId: context.input.request.projectId,
      projectRevision: context.input.projectRevision + 1,
      repaired: true,
    }),
  });

  const repair = sequence({
    id: 'repair-pdf-mapping',
    nodes: [selectRepairState, finalizeSources, persistRepair] as const,
  });
  const routeRepair = routeBy({
    cases: { ready: returnReady, repair },
    id: 'route-pdf-mapping-repair',
    inputSchema: PdfMappingRepairPreparationSchema,
    outputSchema: PdfMappingRepairResultSchema,
    select: input => input.kind,
  });
  const publishRevision = emit({
    event: COURSE_PROJECT_REVISION_EVENT,
    id: 'publish-pdf-mapping-project-revision',
    inputSchema: PdfMappingRepairResultSchema,
    payload: result =>
      ProjectRevisionEventSchema.parse({
        projectId: result.projectId,
        revision: result.projectRevision,
      }),
  });

  return workflow({
    configSchema,
    events: {
      [COURSE_PROJECT_REVISION_EVENT]: {
        durability: 'durable',
        schema: ProjectRevisionEventSchema,
        schemaVersion: PROJECT_REVISION_EVENT_SCHEMA_VERSION,
      },
    },
    executionDefaults,
    id: PDF_MAPPING_REPAIR_WORKFLOW_ID,
    inputSchema: PdfMappingRepairWorkflowInputSchema,
    outputSchema: PdfMappingRepairResultSchema,
    root: sequence({
      id: PDF_MAPPING_REPAIR_WORKFLOW_ID,
      nodes: [prepareRepair, routeRepair, publishRevision] as const,
    }),
  });
};

export const createProductionPdfMappingRepairServices = (
  projectStore: ProjectStore = getProjectStore()
): PdfMappingRepairOwnServices => {
  const loadProjectSources = projectStore.loadProjectSources.bind(projectStore);
  const loadProjectWithRevision = projectStore.loadProjectWithRevision.bind(projectStore);
  const prepareCourse = createCoursePreparationStage({
    loadProjectSources,
    loadProjectWithRevision,
  });
  return {
    persistPdfMappingRepair: async ({ input, output, transaction }) => {
      await patchProjectInTransaction(transaction, {
        buildPatch: project => buildPdfMappingRepairCommitPatch(project, input, output),
        projectId: output.projectId,
        updatedAt: timestampIso(),
        userId: input.request.userId,
      });
    },
    preparePdfMappingRepair: createPdfMappingRepairPreparationStage({
      loadProjectWithRevision,
      prepareCourse,
    }),
  };
};
