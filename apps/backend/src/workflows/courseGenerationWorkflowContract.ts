import { LESSON_INSTRUCTION_PACK_IDS } from '@shared/lessonInstructionPacks';
import * as z from 'zod';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import { WorkflowExecutionDefaultsSchema } from './config.js';
import { GlobalModelConfigSchema } from './modelConfigSchema.js';
import type {
  DeepReadonly,
  StepFailure,
  WorkflowProviderEffectExecutor,
  WorkflowStepExecutionIdentity,
} from './types.js';

export const CourseGenerationWorkflowConfigSchema = WorkflowExecutionDefaultsSchema.extend({
  models: GlobalModelConfigSchema,
});

export type CourseGenerationWorkflowConfig = z.infer<
  typeof CourseGenerationWorkflowConfigSchema
> & { readonly models: GlobalModelConfig };

export interface CourseGenerationStageContext<Input> {
  readonly attemptNumber: number;
  readonly config: DeepReadonly<CourseGenerationWorkflowConfig>;
  readonly execution: WorkflowStepExecutionIdentity;
  readonly idempotencyKey: string;
  readonly input: Input;
  readonly previousAttemptFailure?: StepFailure;
  readonly providerEffect?: WorkflowProviderEffectExecutor;
  readonly retryFeedback: string;
  readonly signal: AbortSignal;
}

export type CourseGenerationStage<Input, Output> = (
  context: CourseGenerationStageContext<Input>
) => Promise<Output>;

export const COURSE_YOUTUBE_QUERY_MAX_CHARS = 100;

const CourseAssessmentMessageSchema = z.object({
  role: z.enum(['model', 'user']),
  text: z.string(),
});

const CourseSourceDescriptorSchema = z.object({
  hash: z.string().length(64),
  id: z.string().min(1),
  kind: z.string().min(1),
  mimeType: z.string().min(1),
  name: z.string().min(1),
});

const CourseSourceReferenceSchema = z.object({
  chunkIds: z.array(z.string()),
  pageEnd: z.number().int().positive().optional(),
  pageStart: z.number().int().positive().optional(),
  sourceId: z.string().min(1),
});

const CourseRequiredTextSchema = z.string().regex(/\S/);

const CourseRawLessonFields = {
  description: CourseRequiredTextSchema,
  guidingQuestions: z.array(CourseRequiredTextSchema),
  instructionPacks: z.array(z.enum(LESSON_INSTRUCTION_PACK_IDS)),
  keyConcepts: z.array(CourseRequiredTextSchema),
  miniLab: CourseRequiredTextSchema.nullable(),
  prerequisites: z.array(CourseRequiredTextSchema),
  simplificationRisks: z.array(CourseRequiredTextSchema),
  sourceUrls: z.array(z.url()),
  title: CourseRequiredTextSchema,
  type: z.enum(['prerequisite', 'core', 'summary', 'deep-dive']),
} as const;

const CourseRawLessonSchema = z.object(CourseRawLessonFields);
const CourseRawArchiveLessonSchema = z.object({
  ...CourseRawLessonFields,
  sourceArchiveSelectors: z
    .array(
      z.object({
        kind: z.enum(['directory', 'file']),
        path: z.string().min(1),
      })
    )
    .min(1),
});

const createCourseRawPlanSchema = <LessonSchema extends z.ZodType>(lessonSchema: LessonSchema) =>
  z.object({
    lessonCountReason: CourseRequiredTextSchema,
    modules: z
      .array(
        z.object({
          description: CourseRequiredTextSchema,
          lessons: z.array(lessonSchema).min(1),
          title: CourseRequiredTextSchema,
          type: z.enum(['prerequisite', 'core', 'summary', 'deep-dive']),
        })
      )
      .min(1),
    summary: CourseRequiredTextSchema,
    title: CourseRequiredTextSchema,
  });

export const CourseRawPlanSchema = createCourseRawPlanSchema(CourseRawLessonSchema);
export const CourseRawArchivePlanSchema = createCourseRawPlanSchema(CourseRawArchiveLessonSchema);
const CourseRawPlanOutputSchema = z.union([CourseRawArchivePlanSchema, CourseRawPlanSchema]);

export const CourseLessonSchema = z.object({
  contextPrompt: z.string().optional(),
  description: z.string(),
  id: z.string().min(1),
  instructionPacks: z.array(z.string()).optional(),
  isCompleted: z.boolean(),
  kind: z.literal('lesson'),
  parentId: z.string().optional(),
  primaryChunkIds: z.array(z.string()).optional(),
  primaryChunkMappingSource: z.enum(['fallback', 'mapped']).optional(),
  sourceArchiveSelectors: z
    .array(
      z.object({
        kind: z.enum(['directory', 'file']),
        path: z.string().min(1),
      })
    )
    .optional(),
  sourceReferences: z.array(CourseSourceReferenceSchema).optional(),
  title: z.string().min(1),
  type: z.enum(['prerequisite', 'core', 'summary', 'deep-dive']),
});

const CourseYoutubeTranscriptSchema = z.object({
  segments: z
    .array(
      z.object({
        endSeconds: z.number().nonnegative(),
        startSeconds: z.number().nonnegative(),
        text: z.string(),
      })
    )
    .min(1),
});

export const CourseResearchSourceSchema = z.object({
  note: z.string().optional(),
  title: z.string().min(1),
  url: z.string().optional(),
  videoClip: z
    .object({
      endSeconds: z.number().nonnegative(),
      startSeconds: z.number().nonnegative(),
    })
    .optional(),
  youtubeTranscript: CourseYoutubeTranscriptSchema.optional(),
});

const CourseYoutubeCandidateSchema = z.object({
  title: z.string().min(1),
  url: z.url(),
  youtubeTranscript: CourseYoutubeTranscriptSchema,
});

export const CourseWebResearchSchema = z.object({
  brief: z.string(),
  sources: z.array(CourseResearchSourceSchema),
});

export const CourseYoutubeResearchSchema = z.object({
  candidates: z.array(CourseYoutubeCandidateSchema),
  context: z.string(),
  rationale: z.string(),
  status: z.enum(['completed', 'unavailable']),
});

export const CourseYoutubeQueryPlanSchema = z.object({
  queries: z.array(z.string().min(1).max(COURSE_YOUTUBE_QUERY_MAX_CHARS)).min(1).max(3),
});

export const CourseYoutubeQueryInputSchema = z.object({
  language: z.string().min(1),
  query: z.string().min(1).max(COURSE_YOUTUBE_QUERY_MAX_CHARS),
  queryIndex: z.number().int().nonnegative(),
});

const CourseExerciseSchema = z.object({
  assessedObjective: z.string(),
  attachments: z.array(
    z.object({
      createdAt: z.string(),
      data: z.string(),
      description: z.string().optional(),
      id: z.string().min(1),
      kind: z.enum(['archive', 'text']),
      mimeType: z.string(),
      name: z.string(),
      truncated: z.boolean(),
      truncatedReason: z.string().optional(),
      updatedAt: z.string(),
    })
  ),
  bestScore: z.number().optional(),
  brief: z.string().optional(),
  completedAt: z.string().optional(),
  currentFeedback: z.null(),
  description: z.string(),
  feedbackStale: z.boolean(),
  generatedAt: z.string().optional(),
  groundingSources: z.array(CourseResearchSourceSchema).optional(),
  id: z.string().min(1),
  internalText: z.string().optional(),
  isCompleted: z.boolean(),
  kind: z.literal('exercise'),
  title: z.string().min(1),
  updatedAt: z.string(),
});

export const CourseLearningPlanSchema = z.object({
  applicationExercisePlanningError: z
    .object({
      attempts: z.number().int().positive(),
      lastAttemptAt: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
  applicationExercisePlanningNotes: z.string().optional(),
  applicationExercisePlanningStatus: z.enum(['not-run', 'completed', 'failed']),
  backgroundMusicUrl: z.string().optional(),
  generationNotes: z.string().optional(),
  modules: z
    .array(
      z.object({
        children: z.array(z.discriminatedUnion('kind', [CourseLessonSchema, CourseExerciseSchema])),
        description: z.string().optional(),
        id: z.string().min(1),
        title: z.string().min(1),
        type: z.enum(['prerequisite', 'core', 'summary', 'deep-dive']).optional(),
      })
    )
    .min(1),
  summary: z.string().min(1),
  title: z.string().min(1),
});

const CourseResearchPlanSchema = z.object({
  generatedAt: z.string(),
  lessonCountReason: z.string(),
  lessons: z.array(
    z.object({
      description: z.string(),
      guidingQuestions: z.array(z.string()),
      id: z.string().min(1),
      instructionPacks: z.array(z.string()).optional(),
      keyConcepts: z.array(z.string()),
      miniLab: z.string(),
      moduleId: z.string().min(1),
      moduleTitle: z.string().min(1),
      prerequisites: z.array(z.string()),
      simplificationRisks: z.array(z.string()),
      sourceHints: z.array(CourseResearchSourceSchema),
      title: z.string().min(1),
    })
  ),
  summary: z.string(),
  title: z.string().min(1),
});

const CourseSyllabusLessonSchema = z.object({
  contextPrompt: z.string().optional(),
  description: z.string(),
  id: z.string().min(1),
  instructionPacks: z.array(z.string()).optional(),
  status: z.enum(['pending', 'ready']),
  title: z.string().min(1),
  type: z.literal('lesson'),
});

const CourseSyllabusItemSchema = z.object({
  children: z.array(CourseSyllabusLessonSchema).optional(),
  contextPrompt: z.string().optional(),
  description: z.string(),
  id: z.string().min(1),
  instructionPacks: z.array(z.string()).optional(),
  status: z.enum(['pending', 'ready']),
  title: z.string().min(1),
  type: z.enum(['module', 'lesson']),
});

export const CourseDocumentIndexSchema = z.object({
  chunks: z.array(
    z.object({
      endOffset: z.number().int().nonnegative(),
      headingPath: z.array(z.string()),
      id: z.string().min(1),
      pageEnd: z.number().int().positive().optional(),
      pageStart: z.number().int().positive().optional(),
      sequence: z.number().int().nonnegative(),
      sourceId: z.string().optional(),
      startOffset: z.number().int().nonnegative(),
      text: z.string(),
    })
  ),
  documentTitle: z.string().optional(),
  kind: z.literal('pdf-text-index'),
  mappingQuality: z
    .object({
      coverageRatio: z.number().optional(),
      gapCount: z.number().int().nonnegative().optional(),
      lessonCount: z.number().int().nonnegative().optional(),
      mappedLessonCount: z.number().int().nonnegative().optional(),
      mappingSource: z.enum(['fallback', 'mapped']),
      updatedAt: z.string(),
    })
    .optional(),
  mappingRecovery: z
    .object({
      status: z.literal('exhausted'),
      updatedAt: z.string(),
    })
    .optional(),
  mappingWarnings: z.array(z.string()).optional(),
  pageCount: z.number().int().positive().optional(),
  parsedAt: z.string(),
  sourceHash: z.string().optional(),
  sourceIds: z.array(z.string()).optional(),
});

export const CourseGenerationWorkflowInputSchema = z.object({
  assessmentHistory: z.array(CourseAssessmentMessageSchema),
  mode: z.enum(['document', 'learn']),
  projectId: z.string().min(1),
  userId: z.string().min(1),
});

export const CoursePreparationStateSchema = z.object({
  context: z.object({
    assessmentSummary: z.string(),
    language: z.string().min(1),
    profile: z
      .object({
        context: z.string(),
        experienceLevel: z.string(),
        goals: z.string(),
        language: z.string(),
        learningStyle: z.string(),
        topic: z.string(),
      })
      .nullable(),
    sourceNames: z.array(z.string()),
    sources: z.array(CourseSourceDescriptorSchema),
    topic: z.string().min(1),
  }),
  projectRevision: z.number().int().nonnegative(),
  request: CourseGenerationWorkflowInputSchema.omit({ assessmentHistory: true }),
  stage: z.literal('prepared'),
  strategy: z.enum(['learn', 'single-source', 'source-set', 'archive']),
});

export const CourseResearchStateSchema = CoursePreparationStateSchema.omit({ stage: true }).extend({
  research: z.object({
    web: CourseWebResearchSchema,
    youtube: CourseYoutubeResearchSchema,
  }),
  stage: z.literal('research'),
});

const CoursePlanOutputSchema = z.object({
  plan: CourseLearningPlanSchema,
  researchCoursePlan: CourseResearchPlanSchema.nullable(),
  syllabus: z.array(CourseSyllabusItemSchema),
});

const CoursePlanQualityDimensionSchema = z.object({
  feedback: CourseRequiredTextSchema,
  status: z.enum(['pass', 'needs-refinement']),
});

export const CoursePlanVerificationSchema = z.object({
  coverage: CoursePlanQualityDimensionSchema,
  duplication: CoursePlanQualityDimensionSchema,
  fragmentation: z.object({
    canGroupCoherently: z.boolean(),
    feedback: CourseRequiredTextSchema,
    moduleIds: z.array(z.string().min(1)),
  }),
  granularity: CoursePlanQualityDimensionSchema,
  moduleCohesion: CoursePlanQualityDimensionSchema,
  prerequisites: CoursePlanQualityDimensionSchema,
  progression: CoursePlanQualityDimensionSchema,
  proportionality: CoursePlanQualityDimensionSchema,
  summary: CourseRequiredTextSchema,
  verdict: z.enum(['pass', 'refine']),
});

export const CourseDraftPlanStateSchema = CourseResearchStateSchema.omit({ stage: true }).extend({
  ...CoursePlanOutputSchema.shape,
  rawDraftPlan: CourseRawPlanOutputSchema,
  stage: z.literal('plan-draft'),
});

export const CoursePlanVerificationStateSchema = CourseDraftPlanStateSchema.omit({
  stage: true,
}).extend({
  stage: z.literal('plan-verification'),
  verification: CoursePlanVerificationSchema,
});

export const CourseRefinedPlanStateSchema = CoursePlanVerificationStateSchema.omit({
  stage: true,
}).extend({
  refinedPlan: CoursePlanOutputSchema,
  refinedVerification: CoursePlanVerificationSchema,
  rawRefinedPlan: CourseRawPlanOutputSchema,
  stage: z.literal('plan-refined'),
});

export const CoursePlanStateSchema = CoursePreparationStateSchema.omit({ stage: true }).extend({
  ...CoursePlanOutputSchema.shape,
  stage: z.literal('plan'),
});

export const CourseSourcesFinalizedStateSchema = CoursePlanStateSchema.omit({ stage: true }).extend(
  {
    documentIndex: CourseDocumentIndexSchema.nullable(),
    stage: z.literal('sources-finalized'),
  }
);

export const CourseExercisesStateSchema = CourseSourcesFinalizedStateSchema.omit({
  stage: true,
}).extend({
  stage: z.literal('exercises'),
});

export const CourseGenerationWorkflowResultSchema = z.object({
  firstSectionId: z.string().min(1),
  projectId: z.string().min(1),
  projectRevision: z.number().int().nonnegative(),
});

export const CoursePersistenceStateSchema = z.object({
  committedCourseFingerprint: z.string().length(64),
  committedRunId: z.string().min(1),
  persistedAt: z.string().min(1),
  previous: z.object({
    activeSectionId: z.string().nullable(),
    documentIndexJson: z.string().nullable(),
    isLearnMode: z.boolean(),
    lastCourseGenerationRunId: z.string().nullable(),
    learningPlanJson: z.string().nullable(),
    researchCoursePlanJson: z.string().nullable(),
    researchDossiersJson: z.string().nullable(),
    state: z.string(),
    syllabusJson: z.string(),
    userProfileJson: z.string().nullable(),
  }),
  result: CourseGenerationWorkflowResultSchema,
  stage: z.literal('persistence'),
  userId: z.string().min(1),
});

export type CourseExercisesState = z.infer<typeof CourseExercisesStateSchema>;
export type CourseDraftPlanState = z.infer<typeof CourseDraftPlanStateSchema>;
export type CourseDocumentIndex = z.infer<typeof CourseDocumentIndexSchema>;
export type CourseGenerationWorkflowInput = z.infer<typeof CourseGenerationWorkflowInputSchema>;
export type CourseGenerationWorkflowResult = z.infer<typeof CourseGenerationWorkflowResultSchema>;
export type CourseLearningPlan = z.infer<typeof CourseLearningPlanSchema>;
export type CoursePersistenceState = z.infer<typeof CoursePersistenceStateSchema>;
export type CoursePlanCandidateVerifier = (input: {
  readonly models: DeepReadonly<GlobalModelConfig>;
  readonly plan: CourseLearningPlan;
  readonly rawPlan: CourseRawArchivePlan | CourseRawPlan;
  readonly retryFeedback: string;
  readonly signal: AbortSignal;
  readonly state: CourseResearchState;
}) => Promise<CoursePlanVerification>;
export type CoursePlanState = z.infer<typeof CoursePlanStateSchema>;
export type CoursePlanVerification = z.infer<typeof CoursePlanVerificationSchema>;
export type CoursePlanVerificationState = z.infer<typeof CoursePlanVerificationStateSchema>;
export type CoursePreparationState = z.infer<typeof CoursePreparationStateSchema>;
export type CourseRawArchivePlan = z.infer<typeof CourseRawArchivePlanSchema>;
export type CourseRawPlan = z.infer<typeof CourseRawPlanSchema>;
export type CourseRefinedPlanState = z.infer<typeof CourseRefinedPlanStateSchema>;
export type CourseResearchState = z.infer<typeof CourseResearchStateSchema>;
export type CourseSourcesFinalizedState = z.infer<typeof CourseSourcesFinalizedStateSchema>;
export type CourseWebResearch = z.infer<typeof CourseWebResearchSchema>;
export type CourseYoutubeQueryInput = z.infer<typeof CourseYoutubeQueryInputSchema>;
export type CourseYoutubeQueryPlan = z.infer<typeof CourseYoutubeQueryPlanSchema>;
export type CourseYoutubeResearch = z.infer<typeof CourseYoutubeResearchSchema>;

export const validateRefinedCoursePlan = (state: CourseRefinedPlanState): CoursePlanState => {
  const qualityDimensions = [
    state.refinedVerification.coverage,
    state.refinedVerification.duplication,
    state.refinedVerification.granularity,
    state.refinedVerification.moduleCohesion,
    state.refinedVerification.prerequisites,
    state.refinedVerification.progression,
    state.refinedVerification.proportionality,
  ];
  if (
    state.refinedVerification.verdict !== 'pass' ||
    state.refinedVerification.fragmentation.canGroupCoherently ||
    qualityDimensions.some(dimension => dimension.status !== 'pass')
  ) {
    throw new Error('The refined course plan has unresolved structural quality findings.');
  }
  return CoursePlanStateSchema.parse({
    context: state.context,
    ...state.refinedPlan,
    projectRevision: state.projectRevision,
    request: state.request,
    stage: 'plan',
    strategy: state.strategy,
  });
};
