import * as z from 'zod';
import type { GlobalModelConfig } from '../config/modelConfig.js';

const AiProviderSchema = z.enum(['codex', 'openai', 'openrouter']);
const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high']);
const TextModelSlotSchema = z.enum([
  'artifact',
  'artifactInteractive',
  'assessment',
  'context',
  'course',
  'lesson',
  'progress',
  'research',
]);
const ModelProviderSlotSchema = z.enum([...TextModelSlotSchema.options, 'image']);

export const GlobalModelConfigSchema = z.object({
  aiProvider: AiProviderSchema,
  aiProviderOverrides: z.partialRecord(ModelProviderSlotSchema, AiProviderSchema).optional(),
  artifactInteractiveModel: z.string(),
  artifactInteractiveReasoningEffort: ReasoningEffortSchema,
  artifactModel: z.string(),
  artifactReasoningEffort: ReasoningEffortSchema,
  artifactVisualReviewEnabled: z.boolean(),
  artifactVisualReviewMaxRounds: z.number().int().nonnegative(),
  assessmentModel: z.string(),
  assessmentReasoningEffort: ReasoningEffortSchema,
  codexArtifactInteractiveModel: z.string(),
  codexArtifactModel: z.string(),
  codexAssessmentModel: z.string(),
  codexContextModel: z.string(),
  codexCourseModel: z.string(),
  codexFastModelSlots: z.array(TextModelSlotSchema),
  codexLessonModel: z.string(),
  codexProgressModel: z.string(),
  codexResearchModel: z.string(),
  contextModel: z.string(),
  contextReasoningEffort: ReasoningEffortSchema,
  courseModel: z.string(),
  courseReasoningEffort: ReasoningEffortSchema,
  imageModel: z.string(),
  lessonModel: z.string(),
  lessonReasoningEffort: ReasoningEffortSchema,
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
  progressReasoningEffort: ReasoningEffortSchema,
  researchModel: z.string(),
  researchReasoningEffort: ReasoningEffortSchema,
  ttsModel: z.string(),
  ttsVoice: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<GlobalModelConfig>;

const { researchReasoningEffort: _researchReasoningEffort, ...previousGlobalModelConfigShape } =
  GlobalModelConfigSchema.shape;

export const PreviousGlobalModelConfigSchema = z.object(previousGlobalModelConfigShape);
