import * as z from 'zod';
import type { DurableGlobalModelConfig, GlobalModelConfig } from '../config/modelConfig.js';

const AiProviderSchema = z.enum(['codex', 'openrouter']);
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

const DurableGlobalModelConfigSchema = z.object({
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
  progressModel: z.string(),
  progressReasoningEffort: ReasoningEffortSchema,
  researchModel: z.string(),
  researchReasoningEffort: ReasoningEffortSchema,
  ttsModel: z.string(),
  ttsVoice: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<DurableGlobalModelConfig>;

/**
 * Durable workflow config validates the model settings without the scene fields, which the scene
 * services always read from the live global config. Keeping them out of this schema leaves the
 * fingerprints independent of live scene settings; historical provider contracts are reconstructed
 * separately by the production registry.
 */
export const GlobalModelConfigSchema =
  DurableGlobalModelConfigSchema as unknown as z.ZodType<GlobalModelConfig>;
