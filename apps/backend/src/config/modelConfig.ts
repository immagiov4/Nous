export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';
export type AiProvider = 'codex' | 'openai' | 'openrouter';
export type TextModelSlot =
  | 'artifact'
  | 'artifactInteractive'
  | 'assessment'
  | 'context'
  | 'course'
  | 'lesson'
  | 'progress'
  | 'research';
export type ModelProviderSlot = TextModelSlot | 'image';
export type ModelProviderOverrides = Partial<Record<ModelProviderSlot, AiProvider>>;

export const DEFAULT_TTS_MODEL = 'x-ai/grok-voice-tts-1.0';
export const DEFAULT_TTS_VOICE = 'Ara';
export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-lite-image';
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2';
export const DEFAULT_OPENAI_RESEARCH_MODEL = 'gpt-5-search-api';

const UNAVAILABLE_TTS_MODELS = new Set([
  'openai/gpt-4o-mini-tts',
  'openai/gpt-4o-mini-tts-2025-12-15',
  'mistralai/voxtral-mini-tts-2603',
]);

export interface GlobalModelConfig {
  aiProvider: AiProvider;
  aiProviderOverrides?: ModelProviderOverrides;
  artifactModel: string;
  artifactInteractiveModel: string;
  artifactInteractiveReasoningEffort: ReasoningEffort;
  artifactReasoningEffort: ReasoningEffort;
  artifactVisualReviewMaxRounds: number;
  artifactVisualReviewEnabled: boolean;
  assessmentModel: string;
  assessmentReasoningEffort: ReasoningEffort;
  codexAssessmentModel: string;
  codexArtifactModel: string;
  codexArtifactInteractiveModel: string;
  codexContextModel: string;
  codexCourseModel: string;
  codexFastModelSlots: TextModelSlot[];
  codexLessonModel: string;
  codexProgressModel: string;
  codexResearchModel: string;
  contextModel: string;
  contextReasoningEffort: ReasoningEffort;
  courseModel: string;
  courseReasoningEffort: ReasoningEffort;
  imageModel: string;
  lessonModel: string;
  lessonReasoningEffort: ReasoningEffort;
  openAiAssessmentModel: string;
  openAiArtifactModel: string;
  openAiArtifactInteractiveModel: string;
  openAiContextModel: string;
  openAiCourseModel: string;
  openAiImageModel: string;
  openAiLessonModel: string;
  openAiProgressModel: string;
  openAiResearchModel: string;
  progressModel: string;
  progressReasoningEffort: ReasoningEffort;
  researchModel: string;
  researchReasoningEffort: ReasoningEffort;
  ttsModel: string;
  ttsVoice: string;
  updatedAt: string;
}

export type GlobalModelConfigPatch = Partial<
  Pick<
    GlobalModelConfig,
    | 'aiProvider'
    | 'aiProviderOverrides'
    | 'artifactModel'
    | 'artifactInteractiveModel'
    | 'artifactInteractiveReasoningEffort'
    | 'artifactReasoningEffort'
    | 'artifactVisualReviewMaxRounds'
    | 'artifactVisualReviewEnabled'
    | 'assessmentModel'
    | 'assessmentReasoningEffort'
    | 'codexAssessmentModel'
    | 'codexArtifactModel'
    | 'codexArtifactInteractiveModel'
    | 'codexContextModel'
    | 'codexCourseModel'
    | 'codexFastModelSlots'
    | 'codexLessonModel'
    | 'codexProgressModel'
    | 'codexResearchModel'
    | 'contextModel'
    | 'contextReasoningEffort'
    | 'courseModel'
    | 'courseReasoningEffort'
    | 'imageModel'
    | 'lessonModel'
    | 'lessonReasoningEffort'
    | 'openAiAssessmentModel'
    | 'openAiArtifactModel'
    | 'openAiArtifactInteractiveModel'
    | 'openAiContextModel'
    | 'openAiCourseModel'
    | 'openAiImageModel'
    | 'openAiLessonModel'
    | 'openAiProgressModel'
    | 'openAiResearchModel'
    | 'progressModel'
    | 'progressReasoningEffort'
    | 'researchModel'
    | 'researchReasoningEffort'
    | 'ttsModel'
    | 'ttsVoice'
  >
>;

const DEFAULT_MODEL_CONFIG: Omit<GlobalModelConfig, 'updatedAt'> = {
  aiProvider: (['codex', 'openai', 'openrouter'].includes(process.env.AI_PROVIDER || '')
    ? process.env.AI_PROVIDER
    : 'openrouter') as AiProvider,
  aiProviderOverrides: {},
  artifactModel: process.env.MODEL_ARTIFACT || 'deepseek/deepseek-v4-pro',
  artifactInteractiveModel:
    process.env.MODEL_ARTIFACT_INTERACTIVE || process.env.MODEL_ARTIFACT || 'openai/gpt-5.6-terra',
  artifactInteractiveReasoningEffort: 'low',
  artifactReasoningEffort: 'none',
  artifactVisualReviewMaxRounds: 1,
  artifactVisualReviewEnabled: true,
  assessmentModel: process.env.MODEL_ASSESSMENT || 'google/gemini-3.1-flash-lite',
  assessmentReasoningEffort: 'medium',
  codexAssessmentModel: process.env.CODEX_MODEL_ASSESSMENT || 'gpt-5.6-luna',
  codexArtifactModel: process.env.CODEX_MODEL_ARTIFACT || 'gpt-5.6-sol',
  codexArtifactInteractiveModel:
    process.env.CODEX_MODEL_ARTIFACT_INTERACTIVE ||
    process.env.CODEX_MODEL_ARTIFACT ||
    'gpt-5.6-sol',
  codexContextModel: process.env.CODEX_MODEL_CONTEXT || 'gpt-5.6-luna',
  codexCourseModel: process.env.CODEX_MODEL_COURSE || 'gpt-5.6-luna',
  codexFastModelSlots: ['artifact', 'artifactInteractive', 'course', 'lesson'],
  codexLessonModel: process.env.CODEX_MODEL_LESSON || 'gpt-5.6-terra',
  codexProgressModel: process.env.CODEX_MODEL_PROGRESS || 'gpt-5.6-luna',
  codexResearchModel: process.env.CODEX_MODEL_RESEARCH || 'gpt-5.6-terra',
  contextModel: process.env.MODEL_CONTEXT || 'google/gemini-3.1-flash-lite',
  contextReasoningEffort: 'medium',
  courseModel: process.env.MODEL_COURSE || 'openai/gpt-5.6-luna',
  courseReasoningEffort: 'medium',
  imageModel: process.env.MODEL_IMAGE || DEFAULT_IMAGE_MODEL,
  lessonModel: process.env.MODEL_LESSON || 'openai/gpt-5.6-luna',
  lessonReasoningEffort: 'high',
  openAiAssessmentModel: process.env.OPENAI_MODEL_ASSESSMENT || 'gpt-5.6-luna',
  openAiArtifactModel: process.env.OPENAI_MODEL_ARTIFACT || 'gpt-5.6-terra',
  openAiArtifactInteractiveModel:
    process.env.OPENAI_MODEL_ARTIFACT_INTERACTIVE ||
    process.env.OPENAI_MODEL_ARTIFACT ||
    'gpt-5.6-terra',
  openAiContextModel: process.env.OPENAI_MODEL_CONTEXT || 'gpt-5.6-luna',
  openAiCourseModel: process.env.OPENAI_MODEL_COURSE || 'gpt-5.6-terra',
  openAiImageModel: process.env.OPENAI_MODEL_IMAGE || DEFAULT_OPENAI_IMAGE_MODEL,
  openAiLessonModel: process.env.OPENAI_MODEL_LESSON || 'gpt-5.6-terra',
  openAiProgressModel: process.env.OPENAI_MODEL_PROGRESS || 'gpt-5.6-luna',
  openAiResearchModel: process.env.OPENAI_MODEL_RESEARCH || DEFAULT_OPENAI_RESEARCH_MODEL,
  progressModel: process.env.MODEL_PROGRESS || 'google/gemini-3.1-flash-lite',
  progressReasoningEffort: 'low',
  researchModel: process.env.MODEL_RESEARCH_PLANNER || 'perplexity/sonar-pro-search',
  researchReasoningEffort: 'none',
  ttsModel: process.env.MODEL_TTS || DEFAULT_TTS_MODEL,
  ttsVoice: process.env.TTS_VOICE || DEFAULT_TTS_VOICE,
};

let activeModelConfig: GlobalModelConfig = {
  ...DEFAULT_MODEL_CONFIG,
  updatedAt: new Date(0).toISOString(),
};
let persistedModelConfigPromise: Promise<GlobalModelConfig> | null = null;

interface PersistedModelConfigRow {
  id?: 'global';
  ai_provider?: string;
  ai_provider_overrides?: unknown;
  artifact_model?: string;
  artifact_interactive_model?: string;
  artifact_interactive_reasoning_effort?: string;
  artifact_reasoning_effort?: string;
  artifact_visual_review_max_rounds?: number;
  artifact_visual_review_enabled?: boolean;
  assessment_model?: string;
  assessment_reasoning_effort?: string;
  codex_assessment_model?: string;
  codex_artifact_model?: string;
  codex_artifact_interactive_model?: string;
  codex_context_model?: string;
  codex_course_model?: string;
  codex_fast_model_slots?: unknown;
  codex_lesson_model?: string;
  codex_progress_model?: string;
  codex_research_model?: string;
  context_model?: string;
  context_reasoning_effort?: string;
  course_model?: string;
  course_reasoning_effort?: string;
  image_model?: string;
  lesson_model?: string;
  lesson_reasoning_effort?: string;
  openai_assessment_model?: string;
  openai_artifact_model?: string;
  openai_artifact_interactive_model?: string;
  openai_context_model?: string;
  openai_course_model?: string;
  openai_image_model?: string;
  openai_lesson_model?: string;
  openai_progress_model?: string;
  openai_research_model?: string;
  progress_model?: string;
  progress_reasoning_effort?: string;
  research_model?: string;
  research_reasoning_effort?: string;
  tts_model?: string;
  tts_voice?: string;
  updated_at?: string;
}

const readConfigValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const REASONING_EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high']);
const AI_PROVIDERS = new Set<AiProvider>(['codex', 'openai', 'openrouter']);
const TEXT_MODEL_SLOTS = new Set<TextModelSlot>([
  'artifact',
  'artifactInteractive',
  'assessment',
  'context',
  'course',
  'lesson',
  'progress',
  'research',
]);
const MODEL_PROVIDER_SLOTS = new Set<ModelProviderSlot>([...TEXT_MODEL_SLOTS, 'image']);

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && REASONING_EFFORTS.has(value as ReasoningEffort);

export const isAiProvider = (value: unknown): value is AiProvider =>
  typeof value === 'string' && AI_PROVIDERS.has(value as AiProvider);

export const isTextModelSlot = (value: unknown): value is TextModelSlot =>
  typeof value === 'string' && TEXT_MODEL_SLOTS.has(value as TextModelSlot);

const isModelProviderSlot = (value: unknown): value is ModelProviderSlot =>
  typeof value === 'string' && MODEL_PROVIDER_SLOTS.has(value as ModelProviderSlot);

export const readModelProviderOverrides = (value: unknown): ModelProviderOverrides => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [ModelProviderSlot, AiProvider] =>
        isModelProviderSlot(entry[0]) && isAiProvider(entry[1])
    )
  );
};

const readReasoningEffort = (value: unknown, fallback: ReasoningEffort): ReasoningEffort =>
  isReasoningEffort(value) ? value : fallback;

const readFastModelSlots = (value: unknown, fallback: TextModelSlot[]): TextModelSlot[] =>
  Array.isArray(value)
    ? value.filter(
        (slot, index): slot is TextModelSlot =>
          isTextModelSlot(slot) && value.indexOf(slot) === index
      )
    : fallback;

export const getGlobalModelConfig = (): GlobalModelConfig => activeModelConfig;

export const resolveAiProviderForSlot = (
  config: GlobalModelConfig,
  slot: ModelProviderSlot
): AiProvider => config.aiProviderOverrides?.[slot] || config.aiProvider;

export const resolveCodexServiceTierForSlot = (
  config: GlobalModelConfig,
  slot: TextModelSlot
): 'fast' | undefined => (config.codexFastModelSlots.includes(slot) ? 'fast' : undefined);

const PROVIDER_MODEL_FIELDS: Record<AiProvider, Record<TextModelSlot, keyof GlobalModelConfig>> = {
  codex: {
    artifact: 'codexArtifactModel',
    artifactInteractive: 'codexArtifactInteractiveModel',
    assessment: 'codexAssessmentModel',
    context: 'codexContextModel',
    course: 'codexCourseModel',
    lesson: 'codexLessonModel',
    progress: 'codexProgressModel',
    research: 'codexResearchModel',
  },
  openai: {
    artifact: 'openAiArtifactModel',
    artifactInteractive: 'openAiArtifactInteractiveModel',
    assessment: 'openAiAssessmentModel',
    context: 'openAiContextModel',
    course: 'openAiCourseModel',
    lesson: 'openAiLessonModel',
    progress: 'openAiProgressModel',
    research: 'openAiResearchModel',
  },
  openrouter: {
    artifact: 'artifactModel',
    artifactInteractive: 'artifactInteractiveModel',
    assessment: 'assessmentModel',
    context: 'contextModel',
    course: 'courseModel',
    lesson: 'lessonModel',
    progress: 'progressModel',
    research: 'researchModel',
  },
};

const REASONING_EFFORT_FIELDS: Record<TextModelSlot, keyof GlobalModelConfig> = {
  artifact: 'artifactReasoningEffort',
  artifactInteractive: 'artifactInteractiveReasoningEffort',
  assessment: 'assessmentReasoningEffort',
  context: 'contextReasoningEffort',
  course: 'courseReasoningEffort',
  lesson: 'lessonReasoningEffort',
  progress: 'progressReasoningEffort',
  research: 'researchReasoningEffort',
};

export const resolveTextModelConfig = (
  config: GlobalModelConfig,
  slot: TextModelSlot
): { model: string; reasoningEffort: ReasoningEffort } => {
  const provider = resolveAiProviderForSlot(config, slot);
  const model = config[PROVIDER_MODEL_FIELDS[provider][slot]];
  const reasoningEffort =
    slot === 'research'
      ? (config.researchReasoningEffort ?? 'none')
      : config[REASONING_EFFORT_FIELDS[slot]];
  return {
    model: model as string,
    reasoningEffort: reasoningEffort as ReasoningEffort,
  };
};

export const getResolvedGlobalModelConfig = async (): Promise<GlobalModelConfig> => {
  if (!isPersistentModelConfigEnabled()) {
    return activeModelConfig;
  }

  persistedModelConfigPromise ??= loadPersistedGlobalModelConfig().catch(error => {
    persistedModelConfigPromise = null;
    throw error;
  });
  return persistedModelConfigPromise;
};

export const getResolvedModelConfigForProvider = async (
  requestedProvider: unknown,
  requestedProviderOverrides?: unknown
): Promise<GlobalModelConfig> => {
  const config = await getResolvedGlobalModelConfig();
  const aiProviderOverrides = readModelProviderOverrides(requestedProviderOverrides);
  if (isAiProvider(requestedProvider)) {
    return { ...config, aiProvider: requestedProvider, aiProviderOverrides };
  }
  return {
    ...config,
    aiProviderOverrides: { ...config.aiProviderOverrides, ...aiProviderOverrides },
  };
};

const buildPatchedGlobalModelConfig = (
  currentConfig: GlobalModelConfig,
  patch: GlobalModelConfigPatch
): GlobalModelConfig => ({
  ...currentConfig,
  ...(isAiProvider(patch.aiProvider) ? { aiProvider: patch.aiProvider } : {}),
  ...(patch.aiProviderOverrides
    ? { aiProviderOverrides: readModelProviderOverrides(patch.aiProviderOverrides) }
    : {}),
  ...(readConfigValue(patch.artifactModel)
    ? { artifactModel: readConfigValue(patch.artifactModel) }
    : {}),
  ...(readConfigValue(patch.artifactInteractiveModel)
    ? { artifactInteractiveModel: readConfigValue(patch.artifactInteractiveModel) }
    : {}),
  ...(isReasoningEffort(patch.artifactInteractiveReasoningEffort)
    ? { artifactInteractiveReasoningEffort: patch.artifactInteractiveReasoningEffort }
    : {}),
  ...(isReasoningEffort(patch.artifactReasoningEffort)
    ? { artifactReasoningEffort: patch.artifactReasoningEffort }
    : {}),
  ...(typeof patch.artifactVisualReviewEnabled === 'boolean'
    ? { artifactVisualReviewEnabled: patch.artifactVisualReviewEnabled }
    : {}),
  ...(Number.isInteger(patch.artifactVisualReviewMaxRounds) &&
  Number(patch.artifactVisualReviewMaxRounds) >= 1 &&
  Number(patch.artifactVisualReviewMaxRounds) <= 4
    ? { artifactVisualReviewMaxRounds: Number(patch.artifactVisualReviewMaxRounds) }
    : {}),
  ...(readConfigValue(patch.assessmentModel)
    ? { assessmentModel: readConfigValue(patch.assessmentModel) }
    : {}),
  ...(isReasoningEffort(patch.assessmentReasoningEffort)
    ? { assessmentReasoningEffort: patch.assessmentReasoningEffort }
    : {}),
  ...(readConfigValue(patch.codexAssessmentModel)
    ? { codexAssessmentModel: readConfigValue(patch.codexAssessmentModel) }
    : {}),
  ...(readConfigValue(patch.codexArtifactModel)
    ? { codexArtifactModel: readConfigValue(patch.codexArtifactModel) }
    : {}),
  ...(readConfigValue(patch.codexArtifactInteractiveModel)
    ? { codexArtifactInteractiveModel: readConfigValue(patch.codexArtifactInteractiveModel) }
    : {}),
  ...(readConfigValue(patch.codexContextModel)
    ? { codexContextModel: readConfigValue(patch.codexContextModel) }
    : {}),
  ...(readConfigValue(patch.codexCourseModel)
    ? { codexCourseModel: readConfigValue(patch.codexCourseModel) }
    : {}),
  ...(Array.isArray(patch.codexFastModelSlots)
    ? { codexFastModelSlots: readFastModelSlots(patch.codexFastModelSlots, []) }
    : {}),
  ...(readConfigValue(patch.codexLessonModel)
    ? { codexLessonModel: readConfigValue(patch.codexLessonModel) }
    : {}),
  ...(readConfigValue(patch.codexProgressModel)
    ? { codexProgressModel: readConfigValue(patch.codexProgressModel) }
    : {}),
  ...(readConfigValue(patch.codexResearchModel)
    ? { codexResearchModel: readConfigValue(patch.codexResearchModel) }
    : {}),
  ...(readConfigValue(patch.contextModel)
    ? { contextModel: readConfigValue(patch.contextModel) }
    : {}),
  ...(isReasoningEffort(patch.contextReasoningEffort)
    ? { contextReasoningEffort: patch.contextReasoningEffort }
    : {}),
  ...(readConfigValue(patch.courseModel)
    ? { courseModel: readConfigValue(patch.courseModel) }
    : {}),
  ...(isReasoningEffort(patch.courseReasoningEffort)
    ? { courseReasoningEffort: patch.courseReasoningEffort }
    : {}),
  ...(readConfigValue(patch.imageModel) ? { imageModel: readConfigValue(patch.imageModel) } : {}),
  ...(readConfigValue(patch.lessonModel)
    ? { lessonModel: readConfigValue(patch.lessonModel) }
    : {}),
  ...(readConfigValue(patch.openAiAssessmentModel)
    ? { openAiAssessmentModel: readConfigValue(patch.openAiAssessmentModel) }
    : {}),
  ...(readConfigValue(patch.openAiArtifactModel)
    ? { openAiArtifactModel: readConfigValue(patch.openAiArtifactModel) }
    : {}),
  ...(readConfigValue(patch.openAiArtifactInteractiveModel)
    ? { openAiArtifactInteractiveModel: readConfigValue(patch.openAiArtifactInteractiveModel) }
    : {}),
  ...(readConfigValue(patch.openAiContextModel)
    ? { openAiContextModel: readConfigValue(patch.openAiContextModel) }
    : {}),
  ...(readConfigValue(patch.openAiCourseModel)
    ? { openAiCourseModel: readConfigValue(patch.openAiCourseModel) }
    : {}),
  ...(readConfigValue(patch.openAiImageModel)
    ? { openAiImageModel: readConfigValue(patch.openAiImageModel) }
    : {}),
  ...(readConfigValue(patch.openAiLessonModel)
    ? { openAiLessonModel: readConfigValue(patch.openAiLessonModel) }
    : {}),
  ...(readConfigValue(patch.openAiProgressModel)
    ? { openAiProgressModel: readConfigValue(patch.openAiProgressModel) }
    : {}),
  ...(readConfigValue(patch.openAiResearchModel)
    ? { openAiResearchModel: readConfigValue(patch.openAiResearchModel) }
    : {}),
  ...(isReasoningEffort(patch.lessonReasoningEffort)
    ? { lessonReasoningEffort: patch.lessonReasoningEffort }
    : {}),
  ...(readConfigValue(patch.progressModel)
    ? { progressModel: readConfigValue(patch.progressModel) }
    : {}),
  ...(isReasoningEffort(patch.progressReasoningEffort)
    ? { progressReasoningEffort: patch.progressReasoningEffort }
    : {}),
  ...(readConfigValue(patch.researchModel)
    ? { researchModel: readConfigValue(patch.researchModel) }
    : {}),
  ...(isReasoningEffort(patch.researchReasoningEffort)
    ? { researchReasoningEffort: patch.researchReasoningEffort }
    : {}),
  ...(readConfigValue(patch.ttsModel) ? { ttsModel: readConfigValue(patch.ttsModel) } : {}),
  ...(readConfigValue(patch.ttsVoice) ? { ttsVoice: readConfigValue(patch.ttsVoice) } : {}),
  updatedAt: new Date().toISOString(),
});

export const patchGlobalModelConfig = (patch: GlobalModelConfigPatch): GlobalModelConfig => {
  activeModelConfig = buildPatchedGlobalModelConfig(activeModelConfig, patch);
  return activeModelConfig;
};

const isPersistentModelConfigEnabled = (): boolean =>
  Boolean(process.env.SUPABASE_URL?.trim()) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());

const getSupabaseRestConfig = () => ({
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '',
  supabaseUrl: (process.env.SUPABASE_URL?.trim() || '').replace(/\/$/, ''),
});

const buildPersistedModelConfig = (config: GlobalModelConfig): PersistedModelConfigRow => ({
  id: 'global',
  ai_provider: config.aiProvider,
  ai_provider_overrides: config.aiProviderOverrides || {},
  artifact_model: config.artifactModel,
  artifact_interactive_model: config.artifactInteractiveModel,
  artifact_interactive_reasoning_effort: config.artifactInteractiveReasoningEffort,
  artifact_reasoning_effort: config.artifactReasoningEffort,
  artifact_visual_review_max_rounds: config.artifactVisualReviewMaxRounds,
  artifact_visual_review_enabled: config.artifactVisualReviewEnabled,
  assessment_model: config.assessmentModel,
  assessment_reasoning_effort: config.assessmentReasoningEffort,
  codex_assessment_model: config.codexAssessmentModel,
  codex_artifact_model: config.codexArtifactModel,
  codex_artifact_interactive_model: config.codexArtifactInteractiveModel,
  codex_context_model: config.codexContextModel,
  codex_course_model: config.codexCourseModel,
  codex_fast_model_slots: config.codexFastModelSlots,
  codex_lesson_model: config.codexLessonModel,
  codex_progress_model: config.codexProgressModel,
  codex_research_model: config.codexResearchModel,
  context_model: config.contextModel,
  context_reasoning_effort: config.contextReasoningEffort,
  course_model: config.courseModel,
  course_reasoning_effort: config.courseReasoningEffort,
  image_model: config.imageModel,
  lesson_model: config.lessonModel,
  lesson_reasoning_effort: config.lessonReasoningEffort,
  openai_assessment_model: config.openAiAssessmentModel,
  openai_artifact_model: config.openAiArtifactModel,
  openai_artifact_interactive_model: config.openAiArtifactInteractiveModel,
  openai_context_model: config.openAiContextModel,
  openai_course_model: config.openAiCourseModel,
  openai_image_model: config.openAiImageModel,
  openai_lesson_model: config.openAiLessonModel,
  openai_progress_model: config.openAiProgressModel,
  openai_research_model: config.openAiResearchModel,
  progress_model: config.progressModel,
  progress_reasoning_effort: config.progressReasoningEffort,
  research_model: config.researchModel,
  research_reasoning_effort: config.researchReasoningEffort,
  tts_model: config.ttsModel,
  tts_voice: config.ttsVoice,
  updated_at: config.updatedAt,
});

const readPersistedModelConfig = (row: PersistedModelConfigRow): GlobalModelConfig => {
  const persistedTtsModel = readConfigValue(row.tts_model);
  const usesUnavailableTtsModel = Boolean(
    persistedTtsModel && UNAVAILABLE_TTS_MODELS.has(persistedTtsModel)
  );

  return {
    aiProvider: isAiProvider(row.ai_provider) ? row.ai_provider : activeModelConfig.aiProvider,
    aiProviderOverrides: readModelProviderOverrides(row.ai_provider_overrides),
    artifactModel: readConfigValue(row.artifact_model) || activeModelConfig.artifactModel,
    artifactInteractiveModel:
      readConfigValue(row.artifact_interactive_model) || activeModelConfig.artifactInteractiveModel,
    artifactInteractiveReasoningEffort: readReasoningEffort(
      row.artifact_interactive_reasoning_effort,
      activeModelConfig.artifactInteractiveReasoningEffort
    ),
    artifactReasoningEffort: readReasoningEffort(
      row.artifact_reasoning_effort,
      activeModelConfig.artifactReasoningEffort
    ),
    artifactVisualReviewEnabled:
      typeof row.artifact_visual_review_enabled === 'boolean'
        ? row.artifact_visual_review_enabled
        : activeModelConfig.artifactVisualReviewEnabled,
    artifactVisualReviewMaxRounds:
      Number.isInteger(row.artifact_visual_review_max_rounds) &&
      Number(row.artifact_visual_review_max_rounds) >= 1 &&
      Number(row.artifact_visual_review_max_rounds) <= 4
        ? Number(row.artifact_visual_review_max_rounds)
        : activeModelConfig.artifactVisualReviewMaxRounds,
    assessmentModel: readConfigValue(row.assessment_model) || activeModelConfig.assessmentModel,
    assessmentReasoningEffort: readReasoningEffort(
      row.assessment_reasoning_effort,
      activeModelConfig.assessmentReasoningEffort
    ),
    codexAssessmentModel:
      readConfigValue(row.codex_assessment_model) || activeModelConfig.codexAssessmentModel,
    codexArtifactModel:
      readConfigValue(row.codex_artifact_model) || activeModelConfig.codexArtifactModel,
    codexArtifactInteractiveModel:
      readConfigValue(row.codex_artifact_interactive_model) ||
      activeModelConfig.codexArtifactInteractiveModel,
    codexContextModel:
      readConfigValue(row.codex_context_model) || activeModelConfig.codexContextModel,
    codexCourseModel: readConfigValue(row.codex_course_model) || activeModelConfig.codexCourseModel,
    codexFastModelSlots: readFastModelSlots(
      row.codex_fast_model_slots,
      activeModelConfig.codexFastModelSlots
    ),
    codexLessonModel: readConfigValue(row.codex_lesson_model) || activeModelConfig.codexLessonModel,
    codexProgressModel:
      readConfigValue(row.codex_progress_model) || activeModelConfig.codexProgressModel,
    codexResearchModel:
      readConfigValue(row.codex_research_model) || activeModelConfig.codexResearchModel,
    contextModel: readConfigValue(row.context_model) || activeModelConfig.contextModel,
    contextReasoningEffort: readReasoningEffort(
      row.context_reasoning_effort,
      activeModelConfig.contextReasoningEffort
    ),
    courseModel: readConfigValue(row.course_model) || activeModelConfig.courseModel,
    courseReasoningEffort: readReasoningEffort(
      row.course_reasoning_effort,
      activeModelConfig.courseReasoningEffort
    ),
    imageModel: readConfigValue(row.image_model) || activeModelConfig.imageModel,
    lessonModel: readConfigValue(row.lesson_model) || activeModelConfig.lessonModel,
    lessonReasoningEffort: readReasoningEffort(
      row.lesson_reasoning_effort,
      activeModelConfig.lessonReasoningEffort
    ),
    openAiAssessmentModel:
      readConfigValue(row.openai_assessment_model) || activeModelConfig.openAiAssessmentModel,
    openAiArtifactModel:
      readConfigValue(row.openai_artifact_model) || activeModelConfig.openAiArtifactModel,
    openAiArtifactInteractiveModel:
      readConfigValue(row.openai_artifact_interactive_model) ||
      activeModelConfig.openAiArtifactInteractiveModel,
    openAiContextModel:
      readConfigValue(row.openai_context_model) || activeModelConfig.openAiContextModel,
    openAiCourseModel:
      readConfigValue(row.openai_course_model) || activeModelConfig.openAiCourseModel,
    openAiImageModel: readConfigValue(row.openai_image_model) || activeModelConfig.openAiImageModel,
    openAiLessonModel:
      readConfigValue(row.openai_lesson_model) || activeModelConfig.openAiLessonModel,
    openAiProgressModel:
      readConfigValue(row.openai_progress_model) || activeModelConfig.openAiProgressModel,
    openAiResearchModel:
      readConfigValue(row.openai_research_model) || activeModelConfig.openAiResearchModel,
    progressModel: readConfigValue(row.progress_model) || activeModelConfig.progressModel,
    progressReasoningEffort: readReasoningEffort(
      row.progress_reasoning_effort,
      activeModelConfig.progressReasoningEffort
    ),
    researchModel: readConfigValue(row.research_model) || activeModelConfig.researchModel,
    researchReasoningEffort: readReasoningEffort(
      row.research_reasoning_effort,
      activeModelConfig.researchReasoningEffort
    ),
    ttsModel: usesUnavailableTtsModel
      ? DEFAULT_TTS_MODEL
      : persistedTtsModel || activeModelConfig.ttsModel,
    ttsVoice: usesUnavailableTtsModel
      ? DEFAULT_TTS_VOICE
      : readConfigValue(row.tts_voice) || activeModelConfig.ttsVoice,
    updatedAt: readConfigValue(row.updated_at) || activeModelConfig.updatedAt,
  };
};

export const loadPersistedGlobalModelConfig = async (): Promise<GlobalModelConfig> => {
  if (!isPersistentModelConfigEnabled()) {
    return activeModelConfig;
  }

  const { serviceRoleKey, supabaseUrl } = getSupabaseRestConfig();
  const response = await fetch(`${supabaseUrl}/rest/v1/model_config?id=eq.global&limit=1`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to load persisted model config: ${response.status}`);
  }

  const rows = (await response.json()) as PersistedModelConfigRow[];
  if (rows[0]) {
    activeModelConfig = readPersistedModelConfig(rows[0]);
  }

  return activeModelConfig;
};

export const patchAndPersistGlobalModelConfig = async (
  patch: GlobalModelConfigPatch
): Promise<GlobalModelConfig> => {
  if (!isPersistentModelConfigEnabled()) {
    const config = buildPatchedGlobalModelConfig(activeModelConfig, patch);
    activeModelConfig = config;
    persistedModelConfigPromise = null;
    return config;
  }

  const persistedConfig = await loadPersistedGlobalModelConfig();
  const config = buildPatchedGlobalModelConfig(persistedConfig, patch);
  const { serviceRoleKey, supabaseUrl } = getSupabaseRestConfig();
  const response = await fetch(`${supabaseUrl}/rest/v1/model_config?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(buildPersistedModelConfig(config)),
  });

  if (!response.ok) {
    throw new Error(`Failed to persist model config: ${response.status}`);
  }

  activeModelConfig = config;
  persistedModelConfigPromise = Promise.resolve(config);
  return config;
};

export const resetModelConfigForTesting = (): void => {
  activeModelConfig = {
    ...DEFAULT_MODEL_CONFIG,
    updatedAt: new Date(0).toISOString(),
  };
  persistedModelConfigPromise = null;
};
