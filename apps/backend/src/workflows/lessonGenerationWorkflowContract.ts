import * as z from 'zod';
import {
  CourseDocumentIndexSchema,
  CourseLessonSchema,
} from './courseGenerationWorkflowContract.js';
import {
  LessonContentDraftSchema,
  LessonDocumentAssetsSchema,
  LessonGenerationInputDataSchema,
  LessonGenerationWarningSchema,
  LessonIdentifierSchema,
  LessonLearningAidSchema,
  LessonPdfImageMetadataSchema,
  LessonPdfImageReferenceSchema,
  LessonQuizSchema,
  LessonResearchDossierSchema,
  LessonResearchSummarySchema,
  LessonResultBlockSchema,
  LessonVisualPlanningDecisionSchema,
  LessonYouTubePlanningSchema,
  ProjectLessonVisualSchema,
  ResearchSourceSchema,
  YouTubeResearchOutcomeSchema,
} from './lessonGenerationWorkflowSchemas.js';
export const LessonGenerationRequestSchema = z.object({
  forceRegenerate: z.boolean(),
  projectId: LessonIdentifierSchema,
  sectionId: LessonIdentifierSchema,
  userId: LessonIdentifierSchema,
});

export const SublessonFocusSchema = z.object({
  annotationNote: z.string().optional(),
  contextAfter: z.string().optional(),
  contextBefore: z.string().optional(),
  instructions: z.string(),
  selectedText: z.string().min(1),
});

const ExistingLessonGenerationInputSchema = LessonGenerationRequestSchema.extend({
  kind: z.literal('existing'),
});

export const SublessonGenerationInputSchema = LessonGenerationRequestSchema.extend({
  focus: SublessonFocusSchema,
  forceRegenerate: z.literal(false),
  kind: z.literal('sublesson'),
  parentSectionId: LessonIdentifierSchema,
});

export const LessonGenerationWorkflowInputSchema = z.discriminatedUnion('kind', [
  ExistingLessonGenerationInputSchema,
  SublessonGenerationInputSchema,
]);

export const SublessonPlanStateSchema = z.object({
  parentSectionId: LessonIdentifierSchema,
  previousActiveSectionId: LessonIdentifierSchema.nullable(),
  projectRevision: z.number().int().nonnegative(),
  request: LessonGenerationRequestSchema,
  section: CourseLessonSchema,
  stage: z.literal('sublesson-plan'),
});

export const SublessonReadyStateSchema = SublessonPlanStateSchema.extend({
  createdDocumentIndex: CourseDocumentIndexSchema.nullable(),
  stage: z.literal('sublesson-ready'),
});

export const LessonContextStateSchema = z.object({
  documentSourceHash: z.string().length(64).nullable(),
  existingDossierJson: z.string().nullable(),
  existingSources: z.array(ResearchSourceSchema),
  lessonInputData: LessonGenerationInputDataSchema,
  originalSources: z.array(ResearchSourceSchema),
  request: LessonGenerationRequestSchema,
  requiresCoverageAssessment: z.boolean(),
  sourceFingerprint: z.string().length(64),
  stage: z.literal('context'),
  targetFingerprint: z.string().length(64),
  youtubePlanning: LessonYouTubePlanningSchema,
  warnings: z.array(LessonGenerationWarningSchema),
});

export const LessonCoverageStateSchema = LessonContextStateSchema.extend({
  stage: z.literal('coverage'),
});

const LessonAssetOwnerSchema = z.object({
  assetIds: z.array(z.string().length(64)),
  nodeInstanceId: LessonIdentifierSchema,
});

export const LessonSourcesStateSchema = LessonCoverageStateSchema.extend({
  documentAssetOwners: z.array(LessonAssetOwnerSchema),
  pdfImages: z.array(LessonPdfImageMetadataSchema),
  stage: z.literal('sources'),
});

export const LessonYouTubePlanStateSchema = LessonSourcesStateSchema.extend({
  stage: z.literal('youtube-plan'),
  youtubeSearchPlan: z
    .object({
      fallbackQuery: z.string(),
      focusConcept: z.string(),
      specificQuery: z.string(),
    })
    .nullable(),
});

export const LessonYouTubeSearchStateSchema = LessonYouTubePlanStateSchema.extend({
  stage: z.literal('youtube-search'),
  youtubeSearchOutcome: YouTubeResearchOutcomeSchema.nullable(),
});

export const LessonYouTubeStateSchema = LessonSourcesStateSchema.extend({
  discoveredYoutubeSources: z.array(ResearchSourceSchema),
  research: z.object({
    context: z.string(),
    youtube: YouTubeResearchOutcomeSchema.nullable(),
  }),
  stage: z.literal('youtube'),
});

export const LessonResearchStateSchema = LessonYouTubeStateSchema.extend({
  lessonSources: z.array(ResearchSourceSchema),
  research: z.object({
    context: z.string(),
    summary: LessonResearchSummarySchema.nullable(),
    youtube: YouTubeResearchOutcomeSchema.nullable(),
  }),
  stage: z.literal('research'),
});

export const LessonDraftStateSchema = LessonResearchStateSchema.extend({
  draft: LessonContentDraftSchema,
  stage: z.literal('draft'),
});

export const LessonReviewedStateSchema = z.object({
  documentAssetOwners: z.array(LessonAssetOwnerSchema),
  documentSourceHash: z.string().length(64).nullable(),
  draft: LessonContentDraftSchema,
  existingDossierJson: z.string().nullable(),
  lessonInputData: LessonGenerationInputDataSchema.pick({
    description: true,
    imageCandidates: true,
    sectionTitle: true,
  }),
  lessonSources: z.array(ResearchSourceSchema),
  pdfImages: z.array(LessonPdfImageMetadataSchema),
  request: LessonGenerationRequestSchema,
  research: z.object({
    summary: LessonResearchSummarySchema.nullable(),
    youtube: YouTubeResearchOutcomeSchema.nullable(),
  }),
  sourceFingerprint: z.string().length(64),
  stage: z.literal('review'),
  targetFingerprint: z.string().length(64),
  warnings: z.array(LessonGenerationWarningSchema),
});

export const LessonAidsStateSchema = LessonReviewedStateSchema.extend({
  learningAids: z.array(LessonLearningAidSchema),
  stage: z.literal('aids'),
});

const StepFailureBaseShape = {
  code: LessonIdentifierSchema,
  message: LessonIdentifierSchema,
};
const LessonVisualFanOutResultSchema = z.discriminatedUnion('status', [
  z.object({
    assetOwners: z.array(LessonAssetOwnerSchema),
    slotId: LessonIdentifierSchema,
    status: z.literal('completed'),
    visual: ProjectLessonVisualSchema,
  }),
  z.object({
    failure: z.discriminatedUnion('kind', [
      z.object({
        ...StepFailureBaseShape,
        feedback: LessonIdentifierSchema,
        kind: z.literal('corrective'),
      }),
      z.object({
        ...StepFailureBaseShape,
        kind: z.literal('operational'),
        retryAfterMs: z.number().int().nonnegative().optional(),
      }),
      z.object({ ...StepFailureBaseShape, kind: z.literal('permanent') }),
    ]),
    slotId: LessonIdentifierSchema,
    status: z.literal('failed'),
  }),
]);

export const LessonVisualFanOutStateSchema = z.object({
  lesson: LessonAidsStateSchema,
  stage: z.literal('visual-results'),
  visualResults: z.array(LessonVisualFanOutResultSchema),
});

export const LessonVisualsStateSchema = LessonAidsStateSchema.extend({
  content: LessonIdentifierSchema,
  contentBlocks: z.array(LessonResultBlockSchema),
  documentAssets: LessonDocumentAssetsSchema.nullable(),
  generatedVisuals: z.array(ProjectLessonVisualSchema),
  imageRefs: z.array(LessonPdfImageReferenceSchema),
  quiz: z.array(LessonQuizSchema),
  stage: z.literal('visuals'),
  visualAssetOwners: z.array(LessonAssetOwnerSchema),
  visualPlanningDecision: LessonVisualPlanningDecisionSchema,
});

export const LessonGenerationWorkflowResultSchema = z.object({
  alreadyCompleted: z.boolean().optional(),
  content: LessonIdentifierSchema,
  contentBlocks: z.array(LessonResultBlockSchema),
  documentAssets: LessonDocumentAssetsSchema.nullable().optional(),
  generatedVisuals: z.array(ProjectLessonVisualSchema),
  imageRefs: z.array(LessonPdfImageReferenceSchema),
  learningAids: z.array(LessonLearningAidSchema),
  projectId: LessonIdentifierSchema,
  projectRevision: z.number().int().nonnegative().optional(),
  quiz: z.array(LessonQuizSchema),
  researchDossier: LessonResearchDossierSchema.optional(),
  sectionId: LessonIdentifierSchema,
  visualPlanningDecision: LessonVisualPlanningDecisionSchema.optional(),
  warnings: z.array(LessonGenerationWarningSchema),
});

export const LessonGenerationPreparationOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('already-completed'),
    result: LessonGenerationWorkflowResultSchema,
  }),
  z.object({
    kind: z.literal('generate'),
    state: LessonContextStateSchema,
  }),
]);

const PersistedLessonGenerationResultSchema = LessonGenerationWorkflowResultSchema.extend({
  researchDossier: LessonResearchDossierSchema,
});

export const LessonPersistenceStateSchema = z.object({
  committedTargetFingerprint: z.string().length(64),
  persistedAt: z.string().min(1),
  previous: z.object({
    documentAssetsJson: z.string().nullable(),
    researchDossierJson: z.string().nullable(),
    sectionJson: z.string(),
  }),
  result: PersistedLessonGenerationResultSchema,
  stage: z.literal('persistence'),
  userId: LessonIdentifierSchema,
});

export type LessonDraftState = z.infer<typeof LessonDraftStateSchema>;
export type LessonAidsState = z.infer<typeof LessonAidsStateSchema>;
export type LessonContextState = z.infer<typeof LessonContextStateSchema>;
export type LessonCoverageState = z.infer<typeof LessonCoverageStateSchema>;
export type LessonGenerationWorkflowInput = z.infer<typeof LessonGenerationWorkflowInputSchema>;
export type LessonGenerationRequest = z.infer<typeof LessonGenerationRequestSchema>;
export type SublessonGenerationInput = z.infer<typeof SublessonGenerationInputSchema>;
export type SublessonPlanState = z.infer<typeof SublessonPlanStateSchema>;
export type SublessonReadyState = z.infer<typeof SublessonReadyStateSchema>;
export type LessonGenerationPreparationOutcome = z.infer<
  typeof LessonGenerationPreparationOutcomeSchema
>;
export type LessonGenerationWorkflowResult = z.infer<typeof LessonGenerationWorkflowResultSchema>;
export type LessonPersistenceState = z.infer<typeof LessonPersistenceStateSchema>;
export type LessonResearchState = z.infer<typeof LessonResearchStateSchema>;
export type LessonReviewedState = z.infer<typeof LessonReviewedStateSchema>;
export type LessonSourcesState = z.infer<typeof LessonSourcesStateSchema>;
export type LessonYouTubePlanState = z.infer<typeof LessonYouTubePlanStateSchema>;
export type LessonYouTubeSearchState = z.infer<typeof LessonYouTubeSearchStateSchema>;
export type LessonVisualsState = z.infer<typeof LessonVisualsStateSchema>;
export type LessonVisualFanOutState = z.infer<typeof LessonVisualFanOutStateSchema>;
export type LessonYouTubeState = z.infer<typeof LessonYouTubeStateSchema>;
