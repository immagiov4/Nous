import { LESSON_VISUAL_TYPES } from '@shared/lessonGenerationPolicy';
import { LESSON_INSTRUCTION_PACK_IDS } from '@shared/lessonInstructionPacks';
import type { ProjectAssetRef, ProjectLessonVisual } from '@shared/projectAsset';
import * as z from 'zod';

import { YouTubeCandidateDecisionSchema } from '../services/lessonResearchContract.js';

export { LessonResearchSummarySchema } from '../services/lessonResearchContract.js';

const SHA256_HEX_LENGTH = 64;
export const Sha256HexSchema = z.string().length(SHA256_HEX_LENGTH);
export const LessonIdentifierSchema = z.string().min(1);
const TimestampSchema = z.string().min(1);

const TranscriptRangeSchema = z.object({
  endSeconds: z.number().nonnegative(),
  startSeconds: z.number().nonnegative(),
});

const YouTubeTranscriptSegmentSchema = TranscriptRangeSchema.extend({
  text: z.string(),
});

export const ProjectAssetRefSchema: z.ZodType<ProjectAssetRef> = z.object({
  byteSize: z.number().int().nonnegative(),
  hash: Sha256HexSchema,
  id: Sha256HexSchema,
  mediaType: LessonIdentifierSchema,
});

export const ResearchSourceSchema = z.object({
  chunkIds: z.array(LessonIdentifierSchema).optional(),
  note: z.string().optional(),
  pageEnd: z.number().int().positive().optional(),
  pageStart: z.number().int().positive().optional(),
  sourceId: LessonIdentifierSchema.optional(),
  title: LessonIdentifierSchema,
  url: LessonIdentifierSchema.optional(),
  videoClip: TranscriptRangeSchema.optional(),
  youtubeTranscript: z
    .object({
      segments: z.array(YouTubeTranscriptSegmentSchema).min(1),
    })
    .optional(),
});

const YouTubeVideoEvidenceSchema = z.object({
  commentCount: z.number().int().nonnegative().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  segments: z.array(YouTubeTranscriptSegmentSchema),
  title: LessonIdentifierSchema,
  url: LessonIdentifierSchema,
  viewCount: z.number().int().nonnegative().optional(),
});

export const YouTubeResearchOutcomeSchema = z.object({
  context: z.string(),
  discoveredVideoCount: z.number().int().nonnegative(),
  rationale: z.string(),
  videoCandidates: z.array(YouTubeVideoEvidenceSchema),
});

export const LessonResearchDossierSchema = z.object({
  avoidOversimplifying: z.array(z.string()).optional(),
  controversies: z.array(z.string()).optional(),
  difficultSteps: z.array(z.string()).optional(),
  factualSummary: z.string().optional(),
  generatedAt: TimestampSchema.optional(),
  keyExamples: z.array(z.string()).optional(),
  recentDevelopments: z.array(z.string()).optional(),
  sectionId: LessonIdentifierSchema,
  sources: z.array(ResearchSourceSchema),
  title: LessonIdentifierSchema,
  youtubeResearch: z
    .object({
      candidateDecisions: z.array(YouTubeCandidateDecisionSchema),
      outcome: z.enum(['completed', 'failed']),
      rationale: z.string(),
    })
    .optional(),
});

const LessonPdfImageMetadataPrefixShape = {
  asset: ProjectAssetRefSchema,
  caption: z.string().optional(),
  id: LessonIdentifierSchema,
  intrinsicHeight: z.number().int().positive().optional(),
  intrinsicWidth: z.number().int().positive().optional(),
  pageNumber: z.number().int().positive().optional(),
};
const LessonPdfImageMetadataSuffixShape = {
  sourceId: LessonIdentifierSchema.optional(),
  sourceOrder: z.number().int().nonnegative(),
  textAfter: z.string(),
  textBefore: z.string(),
  textCurrent: z.string().optional(),
};

export const LessonPdfImageMetadataSchema = z.object({
  ...LessonPdfImageMetadataPrefixShape,
  sourceHash: Sha256HexSchema.optional(),
  ...LessonPdfImageMetadataSuffixShape,
});
export const PreviousLessonPdfImageMetadataSchema = z.object({
  ...LessonPdfImageMetadataPrefixShape,
  ...LessonPdfImageMetadataSuffixShape,
});

const LessonImageCandidateSchema = z.object({
  caption: z.string().optional(),
  id: LessonIdentifierSchema,
  intrinsicHeight: z.number().int().positive().optional(),
  intrinsicWidth: z.number().int().positive().optional(),
  pageNumber: z.number().int().positive().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sourceOrder: z.number().int().nonnegative(),
  textAfter: z.string().optional(),
  textBefore: z.string().optional(),
  textCurrent: z.string().optional(),
  visibleLabel: LessonIdentifierSchema,
});

export const LessonPdfImageReferenceSchema = z.object({
  alt: z.string(),
  anchorHeading: z.string().optional(),
  assetId: LessonIdentifierSchema,
  caption: z.string().optional(),
});

const LessonDraftImageReferenceSchema = z.object({
  alt: z.string(),
  anchorHeading: z.string(),
  assetId: LessonIdentifierSchema,
  caption: z.string(),
});

export const LessonQuizSchema = z.object({
  correctIndex: z.number().int().nonnegative().max(3),
  exerciseType: LessonIdentifierSchema,
  options: z.array(z.string()).length(4),
  question: LessonIdentifierSchema,
});

const MarkdownBlockSchema = z.object({
  markdown: z.string(),
  type: z.literal('markdown'),
});

const InlineQuizBlockSchema = z.object({
  quiz: LessonQuizSchema,
  type: z.literal('inline-quiz'),
});

const YouTubeClipsBlockSchema = z.object({
  clips: z.array(
    z.object({
      endSeconds: z.number().nonnegative(),
      sourceIndex: z.number().int().nonnegative(),
      startSeconds: z.number().nonnegative(),
      title: z.string(),
    })
  ),
  type: z.literal('youtube-clips'),
});

const GeneratedVisualSlotSchema = z.object({
  slotId: LessonIdentifierSchema,
  type: z.literal('generated-visual'),
});

const LessonVisualPlanSchema = z.object({
  altText: z.string(),
  anchorHeading: z.string(),
  complexity: z.enum(['complex', 'moderate', 'simple']),
  concept: LessonIdentifierSchema,
  coverage: z.enum(['all_elements', 'complete_synthesis', 'none', 'single_complex']),
  coverageRationale: z.string(),
  factualRequirements: z.array(z.string()),
  interactionLevel: z.enum(['high', 'low', 'none']),
  pedagogicalGoal: z.string(),
  reason: z.string(),
  requiresDepiction: z.boolean(),
  slotId: LessonIdentifierSchema,
  title: z.string(),
  visualDirection: z.string(),
  visualType: z.enum(LESSON_VISUAL_TYPES),
});

export const LessonVisualRetryPlanSchema = LessonVisualPlanSchema.extend({
  altText: z.string().optional(),
  anchorHeading: z.string().optional(),
  title: z.string().optional(),
});

const LessonDraftBlockSchema = z.union([
  MarkdownBlockSchema,
  InlineQuizBlockSchema,
  YouTubeClipsBlockSchema,
  GeneratedVisualSlotSchema,
]);

export const LessonContentDraftSchema = z.object({
  contentBlocks: z.array(LessonDraftBlockSchema),
  generatedVisuals: z.array(LessonVisualPlanSchema),
  imageRefs: z.array(LessonDraftImageReferenceSchema),
});

export const ProjectVisualSchema = z.union([
  z.object({ asset: ProjectAssetRefSchema, kind: z.literal('image') }),
  z.object({
    code: LessonIdentifierSchema,
    embeddedAssets: z.array(ProjectAssetRefSchema),
    kind: z.literal('html'),
  }),
  z.object({ code: LessonIdentifierSchema, kind: z.literal('svg') }),
  z.object({ code: LessonIdentifierSchema, kind: z.literal('mermaid') }),
]);

export const ProjectLessonVisualSchema: z.ZodType<ProjectLessonVisual> = z.object({
  altText: LessonIdentifierSchema.optional(),
  anchorHeading: LessonIdentifierSchema.optional(),
  createdAt: TimestampSchema,
  id: LessonIdentifierSchema,
  render: ProjectVisualSchema,
  slotId: LessonIdentifierSchema,
  title: LessonIdentifierSchema.optional(),
});

export const LessonLearningAidSchema = z.object({
  anchorHeading: LessonIdentifierSchema.optional(),
  content: LessonIdentifierSchema,
  id: LessonIdentifierSchema,
  kind: z.enum(['analogy', 'definition', 'formula', 'symbol']),
  title: LessonIdentifierSchema,
});

const GeneratedVisualResultBlockSchema = z.object({
  slotId: LessonIdentifierSchema,
  type: z.literal('generated-visual'),
  visualId: LessonIdentifierSchema,
});

const GeneratedVisualRetryBlockSchema = z.object({
  retryPlan: LessonVisualRetryPlanSchema,
  slotId: LessonIdentifierSchema,
  type: z.literal('generated-visual'),
});

export const LessonResultBlockSchema = z.union([
  MarkdownBlockSchema,
  InlineQuizBlockSchema,
  YouTubeClipsBlockSchema,
  GeneratedVisualResultBlockSchema,
  GeneratedVisualRetryBlockSchema,
]);

const LessonVisualPlanningPlanSchema = z.object({
  anchorExcerpt: z.string().nullable().optional(),
  anchorHeading: z.string().nullable(),
  concept: LessonIdentifierSchema,
  pedagogicalGoal: z.string(),
  reason: z.string(),
  visualType: z.enum(LESSON_VISUAL_TYPES),
});

const LessonVisualPlanningPassSchema = z.object({
  outcome: z.enum(['failed', 'none', 'visuals']),
  plans: z.array(LessonVisualPlanningPlanSchema),
  rationale: z.string(),
});

export const LessonVisualPlanningDecisionSchema = z.object({
  initial: LessonVisualPlanningPassSchema,
  reviewed: LessonVisualPlanningPassSchema,
  reviewedAt: TimestampSchema,
});

export const LessonDocumentAssetsSchema = z.object({
  imageCount: z.number().int().nonnegative(),
  kind: z.literal('pdf'),
  parsedAt: TimestampSchema,
  sourceHash: Sha256HexSchema.optional(),
  usedImages: z.array(LessonPdfImageMetadataSchema),
});

export const LessonGenerationInputDataSchema = z.object({
  coverageGaps: z.array(z.string()).optional(),
  description: z.string(),
  generationNotes: z.string().optional(),
  imageCandidates: z.array(LessonImageCandidateSchema),
  instructionPacks: z.array(z.enum(LESSON_INSTRUCTION_PACK_IDS)),
  language: LessonIdentifierSchema,
  pedagogicalContext: z.string(),
  previousLessonTitles: z.array(z.string()),
  sectionTitle: LessonIdentifierSchema,
  sourceContext: z.string(),
});

export const LessonGenerationWarningSchema = z.object({
  code: z.enum([
    'lesson_learning_aids_unavailable',
    'lesson_pdf_image_extraction_incomplete',
    'lesson_visual_generation_incomplete',
    'lesson_youtube_research_unavailable',
  ]),
  pageNumber: z.number().int().positive().optional(),
  sourceId: LessonIdentifierSchema.optional(),
  stage: z.enum(['aids', 'sources', 'visuals', 'youtube']),
  subjectId: LessonIdentifierSchema.optional(),
});

export const LessonYouTubePlanningSchema = z.object({
  context: z.string().optional(),
  courseTitle: z.string(),
  keyConcepts: z.array(z.string()),
  practicalTask: z.string().optional(),
});

export type LessonPdfImageMetadata = z.infer<typeof LessonPdfImageMetadataSchema>;
