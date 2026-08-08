import {
  PDF_MAPPING_MAX_PRIMARY_CHUNKS_PER_LESSON,
  PDF_MAPPING_RECOVERY_EXHAUSTED_WARNING,
  PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION,
} from '@shared/pdfDocumentPolicy';
import {
  compressPagesToGaps,
  expandPageRange,
  resolvePdfChunkPageSpan,
  resolvePdfPlanSubstantiveRange,
} from '@shared/pdfTextIndex';
import * as z from 'zod';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import type {
  CourseChunkMappingBatch,
  CourseChunkMappingBatchResult,
  CourseChunkMappingPlan,
  MapCourseLessonChunkBatch,
} from './courseChunkMapping.js';
import {
  buildCourseChunkMappingBatches,
  CourseChunkMappingBatchResultSchema,
  CourseChunkMappingBatchSchema,
  createCourseLessonChunkBatchMapper,
} from './courseChunkMapping.js';
import { CourseModelProviderError } from './courseGenerationModel.js';
import type { CourseSourceMaterial } from './courseGenerationSources.js';
import {
  type CourseDocumentIndex,
  CourseDocumentIndexSchema,
  type CourseGenerationStage,
  type CourseGenerationStageContext,
  type CourseGenerationWorkflowConfig,
  type CourseLearningPlan,
  type CoursePlanState,
  CoursePlanStateSchema,
  type CourseSourcesFinalizedState,
  CourseSourcesFinalizedStateSchema,
} from './courseGenerationWorkflowContract.js';
import { fanOut, routeBy, sequence, step } from './definition.js';
import {
  failPermanently,
  retryOperational,
  runWorkflowStage,
  WorkflowStepError,
} from './retryPolicy.js';
import type { FanOutResult, StepExecutionContext } from './types.js';
import { createWorkflowModelDiagnostic } from './workflowErrorDiagnostics.js';

type ReadSourceMaterials = (
  state: z.infer<typeof CoursePlanStateSchema>,
  signal: AbortSignal
) => Promise<CourseSourceMaterial[]>;

export type BuildCourseDocumentIndex = (
  materials: readonly CourseSourceMaterial[],
  now: () => string
) => CourseDocumentIndex | null;

const COURSE_SOURCE_MAPPING_TIMEOUT_MS = 90_000;

const CourseSourceMappingStateSchema = z.object({
  index: CourseDocumentIndexSchema,
  kind: z.literal('mapping'),
  lessonIds: z.array(z.string().min(1)),
  planState: CoursePlanStateSchema,
});

const CourseSourcePreparationOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), result: CourseSourcesFinalizedStateSchema }),
  CourseSourceMappingStateSchema,
]);

const CourseChunkMappingAttemptSchema = z.discriminatedUnion('status', [
  z.object({ result: CourseChunkMappingBatchResultSchema, status: z.literal('completed') }),
  z.object({ batchIndex: z.number().int().nonnegative(), status: z.literal('failed') }),
]);

const CourseSourceMappingProgressSchema = z.object({
  mappingFailed: z.boolean(),
  mappings: CourseChunkMappingBatchResultSchema.shape.mappings,
  state: CourseSourceMappingStateSchema,
});

type CourseSourcePreparationOutcome = z.infer<typeof CourseSourcePreparationOutcomeSchema>;
type CourseSourceMappingProgress = z.infer<typeof CourseSourceMappingProgressSchema>;

export interface CourseSourceFinalizationServices {
  readonly completeCourseSourceFinalization: CourseGenerationStage<
    CourseSourceMappingProgress,
    CourseSourcesFinalizedState
  >;
  readonly mapCourseSourceBatch: CourseGenerationStage<
    CourseChunkMappingBatch,
    CourseChunkMappingBatchResult
  >;
  readonly prepareCourseSourceFinalization: CourseGenerationStage<
    CoursePlanState,
    CourseSourcePreparationOutcome
  >;
}

type CourseLesson = Extract<
  CourseLearningPlan['modules'][number]['children'][number],
  { kind: 'lesson' }
>;

const getMappableLessons = (plan: CourseChunkMappingPlan): CourseLesson[] =>
  plan.modules.flatMap(module =>
    module.children.filter(
      (child): child is CourseLesson => child.kind === 'lesson' && child.type !== 'summary'
    )
  );

const resolveSubstantiveChunks = (index: CourseDocumentIndex) => {
  if (!index.pageCount || index.pageCount < PDF_PLAN_MIN_PAGES_FOR_EDGE_EXCLUSION) {
    return index.chunks;
  }
  const substantiveRange = resolvePdfPlanSubstantiveRange(index.pageCount);
  const substantive = index.chunks.filter(chunk => {
    const span = resolvePdfChunkPageSpan(index, chunk, index.pageCount);
    if (!span) return true;
    return span.endPage >= substantiveRange.startPage && span.startPage <= substantiveRange.endPage;
  });
  return substantive.length > 0 ? substantive : index.chunks;
};

const measureMappedPageCoverage = (
  index: CourseDocumentIndex,
  mappings: ReadonlyMap<string, readonly string[]>
): { coverageRatio: number; gapCount: number } | undefined => {
  if (!index.pageCount) return undefined;

  const chunksById = new Map(index.chunks.map(chunk => [chunk.id, chunk]));
  const coveredPages = new Set<number>();
  const substantiveRange = resolvePdfPlanSubstantiveRange(index.pageCount);

  for (const chunkIds of mappings.values()) {
    for (const chunkId of chunkIds) {
      const chunk = chunksById.get(chunkId);
      if (!chunk) return undefined;
      const span = resolvePdfChunkPageSpan(index, chunk, index.pageCount);
      if (!span) return undefined;
      const startPage = Math.max(substantiveRange.startPage, span.startPage);
      const endPage = Math.min(substantiveRange.endPage, span.endPage);
      expandPageRange(startPage, endPage).forEach(page => {
        coveredPages.add(page);
      });
    }
  }

  const substantivePages = expandPageRange(substantiveRange.startPage, substantiveRange.endPage);
  const uncoveredPages = substantivePages.filter(page => !coveredPages.has(page));
  const coverageRatio =
    substantiveRange.pageCount > 0 ? coveredPages.size / substantiveRange.pageCount : 1;

  return {
    coverageRatio: Number.parseFloat(coverageRatio.toFixed(4)),
    gapCount: compressPagesToGaps(uncoveredPages).length,
  };
};

export const buildFallbackMappings = (
  plan: CourseChunkMappingPlan,
  index: CourseDocumentIndex
): Map<string, string[]> => {
  const lessons = getMappableLessons(plan);
  const chunks = resolveSubstantiveChunks(index);
  if (lessons.length === 0 || chunks.length === 0) return new Map();
  const windowSize =
    chunks.length >= lessons.length * 2
      ? Math.min(2, PDF_MAPPING_MAX_PRIMARY_CHUNKS_PER_LESSON, chunks.length)
      : 1;
  const maxStartIndex = Math.max(0, chunks.length - windowSize);
  return new Map(
    lessons.map((lesson, indexInPlan) => {
      const ratio = lessons.length === 1 ? 0.5 : indexInPlan / Math.max(1, lessons.length - 1);
      const startIndex = Math.round(ratio * maxStartIndex);
      return [lesson.id, chunks.slice(startIndex, startIndex + windowSize).map(chunk => chunk.id)];
    })
  );
};

export const resolveCourseSourceReferences = (
  chunkIds: readonly string[],
  index: CourseDocumentIndex
) => {
  const chunksById = new Map(index.chunks.map(chunk => [chunk.id, chunk]));
  const references = new Map<
    string,
    { chunkIds: string[]; pageEnd?: number; pageStart?: number; sourceId: string }
  >();
  for (const chunkId of chunkIds) {
    const chunk = chunksById.get(chunkId);
    if (!chunk?.sourceId) continue;
    const reference = references.get(chunk.sourceId) ?? {
      chunkIds: [] as string[],
      sourceId: chunk.sourceId,
    };
    reference.chunkIds.push(chunkId);
    if (chunk.pageStart !== undefined) {
      reference.pageStart = Math.min(reference.pageStart ?? chunk.pageStart, chunk.pageStart);
    }
    if (chunk.pageEnd !== undefined) {
      reference.pageEnd = Math.max(reference.pageEnd ?? chunk.pageEnd, chunk.pageEnd);
    }
    references.set(chunk.sourceId, reference);
  }
  return [...references.values()];
};

const applyCourseLessonMappings = ({
  fallbackIds,
  index,
  mappings,
  plan,
}: {
  readonly fallbackIds: ReadonlySet<string>;
  readonly index: CourseDocumentIndex;
  readonly mappings: ReadonlyMap<string, readonly string[]>;
  readonly plan: CourseLearningPlan;
}): CourseLearningPlan => ({
  ...plan,
  modules: plan.modules.map(module => ({
    ...module,
    children: module.children.map(child => {
      if (child.kind !== 'lesson' || child.type === 'summary') return child;
      const chunkIds = mappings.get(child.id);
      if (!chunkIds?.length) return child;
      return {
        ...child,
        primaryChunkIds: [...chunkIds],
        primaryChunkMappingSource: fallbackIds.has(child.id)
          ? ('fallback' as const)
          : ('mapped' as const),
        sourceReferences: resolveCourseSourceReferences(chunkIds, index),
      };
    }),
  })),
});

const withCourseMappingQuality = ({
  fallbackIds,
  index,
  lessonCount,
  mappings,
  mappedLessonCount,
  now,
}: {
  readonly fallbackIds: ReadonlySet<string>;
  readonly index: CourseDocumentIndex;
  readonly lessonCount: number;
  readonly mappings: ReadonlyMap<string, readonly string[]>;
  readonly mappedLessonCount: number;
  readonly now: () => string;
}): CourseDocumentIndex => {
  const updatedAt = now();
  const pageCoverage = measureMappedPageCoverage(index, mappings);
  if (fallbackIds.size === 0) {
    return {
      ...index,
      mappingQuality: {
        ...pageCoverage,
        lessonCount,
        mappedLessonCount,
        mappingSource: 'mapped',
        updatedAt,
      },
      mappingRecovery: undefined,
      mappingWarnings: (index.mappingWarnings ?? []).filter(
        warning => warning !== PDF_MAPPING_RECOVERY_EXHAUSTED_WARNING
      ),
    };
  }
  return {
    ...index,
    mappingQuality: {
      ...pageCoverage,
      lessonCount,
      mappedLessonCount,
      mappingSource: 'fallback',
      updatedAt,
    },
    mappingRecovery: { status: 'exhausted', updatedAt },
    mappingWarnings: [
      ...new Set([...(index.mappingWarnings ?? []), PDF_MAPPING_RECOVERY_EXHAUSTED_WARNING]),
    ],
  };
};

const needsDocumentIndex = (input: z.infer<typeof CoursePlanStateSchema>): boolean =>
  input.strategy === 'source-set' ||
  (input.strategy === 'single-source' && input.context.sources[0]?.kind === 'pdf');

export const createCourseSourceFinalizationServices = ({
  buildDocumentIndex,
  mapBatch = createCourseLessonChunkBatchMapper(),
  now = () => new Date().toISOString(),
  readSourceMaterials,
}: {
  readonly buildDocumentIndex: BuildCourseDocumentIndex;
  readonly mapBatch?: MapCourseLessonChunkBatch;
  readonly now?: () => string;
  readonly readSourceMaterials: ReadSourceMaterials;
}): CourseSourceFinalizationServices => ({
  completeCourseSourceFinalization: async context => {
    const { index, lessonIds, planState } = context.input.state;
    const mappings = new Map(
      context.input.mappings.map(mapping => [mapping.lessonId, mapping.chunkIds])
    );
    const fallbackIds = new Set<string>();
    if (context.input.mappingFailed) {
      const fallbackMappings = buildFallbackMappings(planState.plan, index);
      for (const lessonId of lessonIds) {
        if (mappings.has(lessonId)) continue;
        const chunkIds = fallbackMappings.get(lessonId);
        if (chunkIds?.length) {
          mappings.set(lessonId, chunkIds);
          fallbackIds.add(lessonId);
        }
      }
    }
    if (lessonIds.some(lessonId => !mappings.has(lessonId))) {
      throw failPermanently({
        code: 'course_chunk_fallback_missing',
        message: 'The course source could not be associated with every lesson.',
      });
    }
    return CourseSourcesFinalizedStateSchema.parse({
      ...planState,
      documentIndex: withCourseMappingQuality({
        fallbackIds,
        index,
        lessonCount: lessonIds.length,
        mappings,
        mappedLessonCount: lessonIds.length - fallbackIds.size,
        now,
      }),
      plan: applyCourseLessonMappings({
        fallbackIds,
        index,
        mappings,
        plan: planState.plan,
      }),
      stage: 'sources-finalized',
    });
  },
  mapCourseSourceBatch: context =>
    mapBatch({
      batch: context.input,
      config: context.config.models,
      retryFeedback: context.retryFeedback,
      signal: context.signal,
    }),
  prepareCourseSourceFinalization: async context => {
    if (!needsDocumentIndex(context.input)) {
      return {
        kind: 'ready',
        result: CourseSourcesFinalizedStateSchema.parse({
          ...context.input,
          documentIndex: null,
          stage: 'sources-finalized',
        }),
      };
    }
    const materials = await readSourceMaterials(context.input, context.signal);
    const index = buildDocumentIndex(materials, now);
    if (!index?.chunks.length) {
      throw failPermanently({
        code: 'course_source_index_missing',
        message: 'The course source could not be indexed.',
      });
    }
    return {
      index,
      kind: 'mapping',
      lessonIds: getMappableLessons(context.input.plan).map(lesson => lesson.id),
      planState: context.input,
    };
  },
});

const completedBatchAttempts = (
  results: readonly FanOutResult<
    CourseChunkMappingBatch,
    z.infer<typeof CourseChunkMappingAttemptSchema>
  >[]
) =>
  results.map(result => {
    if (result.status !== 'completed') {
      throw new Error(`Course source mapping batch ${result.key} did not complete.`);
    }
    return result.output;
  });

const appendBatchAttempts = (
  progress: CourseSourceMappingProgress,
  results: readonly FanOutResult<
    CourseChunkMappingBatch,
    z.infer<typeof CourseChunkMappingAttemptSchema>
  >[]
): CourseSourceMappingProgress => {
  const attempts = completedBatchAttempts(results);
  return {
    mappingFailed: progress.mappingFailed || attempts.some(attempt => attempt.status === 'failed'),
    mappings: [
      ...progress.mappings,
      ...attempts.flatMap(attempt =>
        attempt.status === 'completed' ? attempt.result.mappings : []
      ),
    ],
    state: progress.state,
  };
};

export const createCourseSourceFinalizationNode = <
  Config extends CourseGenerationWorkflowConfig,
  Services extends CourseSourceFinalizationServices,
>() => {
  const runSourceStage = <Input, Output>(
    context: StepExecutionContext<Input, Config, Services>,
    operation: (stage: CourseGenerationStageContext<Input>) => Promise<Output>
  ) =>
    runWorkflowStage({
      failure: {
        code: 'course_source_finalization_failed',
        details: {
          model: createWorkflowModelDiagnostic(
            context.config.models as GlobalModelConfig,
            'course'
          ),
        },
        message: 'The course sources could not be mapped to the plan.',
      },
      operation: () => operation(context),
      signal: context.signal,
    });

  const prepareSources = step<
    typeof CoursePlanStateSchema,
    typeof CourseSourcePreparationOutcomeSchema,
    Config,
    Services
  >({
    id: 'prepare-course-source-finalization',
    inputSchema: CoursePlanStateSchema,
    outputSchema: CourseSourcePreparationOutcomeSchema,
    run: context =>
      runSourceStage(context, stage => context.services.prepareCourseSourceFinalization(stage)),
  });

  const returnWithoutMapping = step<
    typeof CourseSourcePreparationOutcomeSchema,
    typeof CourseSourcesFinalizedStateSchema,
    Config,
    Services
  >({
    id: 'return-course-without-source-mapping',
    inputSchema: CourseSourcePreparationOutcomeSchema,
    outputSchema: CourseSourcesFinalizedStateSchema,
    run: async context => {
      if (context.input.kind !== 'ready') {
        throw new Error('Course source finalization expected an already-ready result.');
      }
      return context.input.result;
    },
  });

  const mappingBatchStep = (id: string) =>
    step<
      typeof CourseChunkMappingBatchSchema,
      typeof CourseChunkMappingAttemptSchema,
      Config,
      Services
    >({
      id,
      inputSchema: CourseChunkMappingBatchSchema,
      outputSchema: CourseChunkMappingAttemptSchema,
      timeoutMs: COURSE_SOURCE_MAPPING_TIMEOUT_MS,
      run: async context => {
        try {
          const result = await context.services.mapCourseSourceBatch(context);
          if (result.batchIndex !== context.input.batchIndex) {
            throw new TypeError('Course source mapping returned a different batch identity.');
          }
          return { result, status: 'completed' };
        } catch (error) {
          context.signal.throwIfAborted();
          let retryableFailure: WorkflowStepError | undefined;
          if (error instanceof CourseModelProviderError) {
            retryableFailure = retryOperational({
              code: 'course_source_finalization_failed',
              details: {
                model: createWorkflowModelDiagnostic(
                  context.config.models as GlobalModelConfig,
                  'course'
                ),
              },
              message: 'The course sources could not be mapped to the plan.',
            });
          } else if (error instanceof WorkflowStepError && error.failure.kind !== 'permanent') {
            retryableFailure = error;
          }
          if (!retryableFailure) throw error;
          if (context.attemptNumber < context.config.maxAttempts) throw retryableFailure;
          return { batchIndex: context.input.batchIndex, status: 'failed' };
        }
      },
    });

  const mapFastBatch = mappingBatchStep('map-course-source-fast-batch');
  const mapRepairBatch = mappingBatchStep('map-course-source-repair-batch');

  const mapFastBatches = fanOut({
    failureMode: 'fail-fast',
    fanIn: (results, parentInput): CourseSourceMappingProgress => {
      if (parentInput.kind !== 'mapping') {
        throw new Error('Course source mapping expected an indexed source.');
      }
      return appendBatchAttempts(
        { mappingFailed: false, mappings: [], state: parentInput },
        results
      );
    },
    id: 'map-course-source-fast-batches',
    inputSchema: CourseSourcePreparationOutcomeSchema,
    inputs: input =>
      input.kind === 'mapping'
        ? buildCourseChunkMappingBatches({
            index: input.index,
            lessonIds: input.lessonIds,
            mode: 'fast',
            plan: input.planState.plan,
          })
        : [],
    itemSchema: CourseChunkMappingBatchSchema,
    keyBy: input => String(input.batchIndex),
    outputSchema: CourseSourceMappingProgressSchema,
    worker: mapFastBatch,
  });

  const mapRepairBatches = fanOut({
    failureMode: 'fail-fast',
    fanIn: (results, parentInput) => appendBatchAttempts(parentInput, results),
    id: 'map-course-source-repair-batches',
    inputSchema: CourseSourceMappingProgressSchema,
    inputs: input => {
      if (input.mappingFailed) return [];
      const mappedLessonIds = new Set(input.mappings.map(mapping => mapping.lessonId));
      const missingLessonIds = input.state.lessonIds.filter(
        lessonId => !mappedLessonIds.has(lessonId)
      );
      return buildCourseChunkMappingBatches({
        index: input.state.index,
        lessonIds: missingLessonIds,
        mode: 'repair',
        plan: input.state.planState.plan,
      });
    },
    itemSchema: CourseChunkMappingBatchSchema,
    keyBy: input => String(input.batchIndex),
    outputSchema: CourseSourceMappingProgressSchema,
    worker: mapRepairBatch,
  });

  const completeSources = step<
    typeof CourseSourceMappingProgressSchema,
    typeof CourseSourcesFinalizedStateSchema,
    Config,
    Services
  >({
    id: 'complete-course-source-finalization',
    inputSchema: CourseSourceMappingProgressSchema,
    outputSchema: CourseSourcesFinalizedStateSchema,
    run: context =>
      runSourceStage(context, stage => context.services.completeCourseSourceFinalization(stage)),
  });

  const mapSources = sequence({
    id: 'map-course-sources',
    nodes: [mapFastBatches, mapRepairBatches, completeSources] as const,
  });

  const routeSources = routeBy({
    cases: { mapping: mapSources, ready: returnWithoutMapping },
    id: 'route-course-source-finalization',
    inputSchema: CourseSourcePreparationOutcomeSchema,
    outputSchema: CourseSourcesFinalizedStateSchema,
    select: input => input.kind,
  });

  return sequence({
    id: 'finalize-course-sources',
    nodes: [prepareSources, routeSources] as const,
  });
};
