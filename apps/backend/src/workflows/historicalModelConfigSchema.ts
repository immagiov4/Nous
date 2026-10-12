import * as z from 'zod';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import type { LessonVisualModelConfig } from '../services/lessonVisualModelConfig.js';

// Frozen contracts reconstruct deployed fingerprints independently of live provider configuration.
const HistoricalAiProviderSchema = z.enum(['codex', 'openai', 'openrouter']);
const HistoricalReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high']);
const HistoricalTextModelSlotSchema = z.enum([
  'artifact',
  'artifactInteractive',
  'assessment',
  'context',
  'course',
  'lesson',
  'progress',
  'research',
]);
const HistoricalModelProviderSlotSchema = z.enum([
  ...HistoricalTextModelSlotSchema.options,
  'image',
]);

const HistoricalDurableGlobalModelConfigSchema = z.object({
  aiProvider: HistoricalAiProviderSchema,
  aiProviderOverrides: z
    .partialRecord(HistoricalModelProviderSlotSchema, HistoricalAiProviderSchema)
    .optional(),
  artifactInteractiveModel: z.string(),
  artifactInteractiveReasoningEffort: HistoricalReasoningEffortSchema,
  artifactModel: z.string(),
  artifactReasoningEffort: HistoricalReasoningEffortSchema,
  artifactVisualReviewEnabled: z.boolean(),
  artifactVisualReviewMaxRounds: z.number().int().nonnegative(),
  assessmentModel: z.string(),
  assessmentReasoningEffort: HistoricalReasoningEffortSchema,
  codexArtifactInteractiveModel: z.string(),
  codexArtifactModel: z.string(),
  codexAssessmentModel: z.string(),
  codexContextModel: z.string(),
  codexCourseModel: z.string(),
  codexFastModelSlots: z.array(HistoricalTextModelSlotSchema),
  codexLessonModel: z.string(),
  codexProgressModel: z.string(),
  codexResearchModel: z.string(),
  contextModel: z.string(),
  contextReasoningEffort: HistoricalReasoningEffortSchema,
  courseModel: z.string(),
  courseReasoningEffort: HistoricalReasoningEffortSchema,
  imageModel: z.string(),
  lessonModel: z.string(),
  lessonReasoningEffort: HistoricalReasoningEffortSchema,
  openAiArtifactInteractiveModel: z.string(),
  openAiArtifactModel: z.string(),
  openAiAssessmentModel: z.string(),
  openAiContextModel: z.string(),
  openAiCourseModel: z.string(),
  openAiImageModel: z.string(),
  openAiLessonModel: z.string(),
  openAiProgressModel: z.string(),
  openAiResearchModel: z.string(),
  progressModel: z.string(),
  progressReasoningEffort: HistoricalReasoningEffortSchema,
  researchModel: z.string(),
  researchReasoningEffort: HistoricalReasoningEffortSchema,
  ttsModel: z.string(),
  ttsVoice: z.string(),
  updatedAt: z.string(),
});

const HistoricalResolvedTextModelConfigSchema = z.object({
  model: z.string().min(1),
  provider: HistoricalAiProviderSchema,
  reasoningEffort: HistoricalReasoningEffortSchema,
  serviceTier: z.literal('fast').optional(),
});

const HistoricalLessonVisualModelConfigSchema = z.object({
  artifact: HistoricalResolvedTextModelConfigSchema,
  artifactInteractive: HistoricalResolvedTextModelConfigSchema,
  image: z.object({
    model: z.string().min(1),
    provider: HistoricalAiProviderSchema,
  }),
  review: z.object({
    enabled: z.boolean(),
    maxRounds: z.number().int().min(1).max(4),
  }),
});

/** Retired fields only satisfy reconstruction defaults; pending runs retain their stored config. */
export const createPreOpenAiRemovalModelConfig = (models: GlobalModelConfig) => ({
  ...models,
  openAiArtifactInteractiveModel: '',
  openAiArtifactModel: '',
  openAiAssessmentModel: '',
  openAiContextModel: '',
  openAiCourseModel: '',
  openAiImageModel: '',
  openAiLessonModel: '',
  openAiProgressModel: '',
  openAiResearchModel: '',
});

export const PreOpenAiRemovalGlobalModelConfigSchema =
  HistoricalDurableGlobalModelConfigSchema as unknown as z.ZodType<GlobalModelConfig>;
export const PreOpenAiRemovalLessonVisualModelConfigSchema =
  HistoricalLessonVisualModelConfigSchema as unknown as z.ZodType<LessonVisualModelConfig>;
