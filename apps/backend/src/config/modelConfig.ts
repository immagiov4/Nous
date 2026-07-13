export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';
export type AiProvider = 'codex' | 'openai' | 'openrouter';
export type TextModelSlot =
  | 'artifact'
  | 'artifactInteractive'
  | 'assessment'
  | 'context'
  | 'lesson'
  | 'progress'
  | 'research';

export const DEFAULT_TTS_MODEL = 'x-ai/grok-voice-tts-1.0';
export const DEFAULT_TTS_VOICE = 'Ara';
export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-lite-image';
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2';

const UNAVAILABLE_TTS_MODELS = new Set([
  'openai/gpt-4o-mini-tts',
  'openai/gpt-4o-mini-tts-2025-12-15',
  'mistralai/voxtral-mini-tts-2603',
]);

export interface GlobalModelConfig {
  aiProvider: AiProvider;
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
  codexLessonModel: string;
  codexProgressModel: string;
  codexResearchModel: string;
  contextModel: string;
  contextReasoningEffort: ReasoningEffort;
  imageModel: string;
  lessonModel: string;
  lessonReasoningEffort: ReasoningEffort;
  openAiAssessmentModel: string;
  openAiArtifactModel: string;
  openAiArtifactInteractiveModel: string;
  openAiContextModel: string;
  openAiImageModel: string;
  openAiLessonModel: string;
  openAiProgressModel: string;
  openAiResearchModel: string;
  progressModel: string;
  progressReasoningEffort: ReasoningEffort;
  researchModel: string;
  ttsModel: string;
  ttsVoice: string;
  updatedAt: string;
}

export type GlobalModelConfigPatch = Partial<
  Pick<
    GlobalModelConfig,
    | 'aiProvider'
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
    | 'codexLessonModel'
    | 'codexProgressModel'
    | 'codexResearchModel'
    | 'contextModel'
    | 'contextReasoningEffort'
    | 'imageModel'
    | 'lessonModel'
    | 'lessonReasoningEffort'
    | 'openAiAssessmentModel'
    | 'openAiArtifactModel'
    | 'openAiArtifactInteractiveModel'
    | 'openAiContextModel'
    | 'openAiImageModel'
    | 'openAiLessonModel'
    | 'openAiProgressModel'
    | 'openAiResearchModel'
    | 'progressModel'
    | 'progressReasoningEffort'
    | 'researchModel'
    | 'ttsModel'
    | 'ttsVoice'
  >
>;

const DEFAULT_MODEL_CONFIG: Omit<GlobalModelConfig, 'updatedAt'> = {
  aiProvider: 'openrouter',
  artifactModel: process.env.MODEL_ARTIFACT || 'openai/gpt-5.4-mini',
  artifactInteractiveModel:
    process.env.MODEL_ARTIFACT_INTERACTIVE || process.env.MODEL_ARTIFACT || 'openai/gpt-5.4-mini',
  artifactInteractiveReasoningEffort: 'medium',
  artifactReasoningEffort: 'medium',
  artifactVisualReviewMaxRounds: 1,
  artifactVisualReviewEnabled: true,
  assessmentModel: process.env.MODEL_ASSESSMENT || 'google/gemini-3.1-flash-lite',
  assessmentReasoningEffort: 'medium',
  codexAssessmentModel: process.env.CODEX_MODEL_ASSESSMENT || 'gpt-5.6-luna',
  codexArtifactModel: process.env.CODEX_MODEL_ARTIFACT || 'gpt-5.6-terra',
  codexArtifactInteractiveModel:
    process.env.CODEX_MODEL_ARTIFACT_INTERACTIVE ||
    process.env.CODEX_MODEL_ARTIFACT ||
    'gpt-5.6-terra',
  codexContextModel: process.env.CODEX_MODEL_CONTEXT || 'gpt-5.6-luna',
  codexLessonModel: process.env.CODEX_MODEL_LESSON || 'gpt-5.6-terra',
  codexProgressModel: process.env.CODEX_MODEL_PROGRESS || 'gpt-5.6-luna',
  codexResearchModel: process.env.CODEX_MODEL_RESEARCH || 'gpt-5.6-terra',
  contextModel: process.env.MODEL_CONTEXT || 'google/gemini-3.1-flash-lite',
  contextReasoningEffort: 'medium',
  imageModel: process.env.MODEL_IMAGE || DEFAULT_IMAGE_MODEL,
  lessonModel: process.env.MODEL_LESSON || 'openai/gpt-5.4-mini',
  lessonReasoningEffort: 'medium',
  openAiAssessmentModel: process.env.OPENAI_MODEL_ASSESSMENT || 'gpt-5.6-luna',
  openAiArtifactModel: process.env.OPENAI_MODEL_ARTIFACT || 'gpt-5.6-terra',
  openAiArtifactInteractiveModel:
    process.env.OPENAI_MODEL_ARTIFACT_INTERACTIVE ||
    process.env.OPENAI_MODEL_ARTIFACT ||
    'gpt-5.6-terra',
  openAiContextModel: process.env.OPENAI_MODEL_CONTEXT || 'gpt-5.6-luna',
  openAiImageModel: process.env.OPENAI_MODEL_IMAGE || DEFAULT_OPENAI_IMAGE_MODEL,
  openAiLessonModel: process.env.OPENAI_MODEL_LESSON || 'gpt-5.6-terra',
  openAiProgressModel: process.env.OPENAI_MODEL_PROGRESS || 'gpt-5.6-luna',
  openAiResearchModel: process.env.OPENAI_MODEL_RESEARCH || 'gpt-5.6-terra',
  progressModel: process.env.MODEL_PROGRESS || 'google/gemini-3.1-flash-lite',
  progressReasoningEffort: 'low',
  researchModel: process.env.MODEL_RESEARCH_PLANNER || 'perplexity/sonar-pro-search',
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
  codex_lesson_model?: string;
  codex_progress_model?: string;
  codex_research_model?: string;
  context_model?: string;
  context_reasoning_effort?: string;
  image_model?: string;
  lesson_model?: string;
  lesson_reasoning_effort?: string;
  openai_assessment_model?: string;
  openai_artifact_model?: string;
  openai_artifact_interactive_model?: string;
  openai_context_model?: string;
  openai_image_model?: string;
  openai_lesson_model?: string;
  openai_progress_model?: string;
  openai_research_model?: string;
  progress_model?: string;
  progress_reasoning_effort?: string;
  research_model?: string;
  tts_model?: string;
  tts_voice?: string;
  updated_at?: string;
}

const readConfigValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const REASONING_EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high']);
const AI_PROVIDERS = new Set<AiProvider>(['codex', 'openai', 'openrouter']);

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && REASONING_EFFORTS.has(value as ReasoningEffort);

export const isAiProvider = (value: unknown): value is AiProvider =>
  typeof value === 'string' && AI_PROVIDERS.has(value as AiProvider);

const readReasoningEffort = (value: unknown, fallback: ReasoningEffort): ReasoningEffort =>
  isReasoningEffort(value) ? value : fallback;

export const getGlobalModelConfig = (): GlobalModelConfig => activeModelConfig;

const PROVIDER_MODEL_FIELDS: Record<AiProvider, Record<TextModelSlot, keyof GlobalModelConfig>> = {
  codex: {
    artifact: 'codexArtifactModel',
    artifactInteractive: 'codexArtifactInteractiveModel',
    assessment: 'codexAssessmentModel',
    context: 'codexContextModel',
    lesson: 'codexLessonModel',
    progress: 'codexProgressModel',
    research: 'codexResearchModel',
  },
  openai: {
    artifact: 'openAiArtifactModel',
    artifactInteractive: 'openAiArtifactInteractiveModel',
    assessment: 'openAiAssessmentModel',
    context: 'openAiContextModel',
    lesson: 'openAiLessonModel',
    progress: 'openAiProgressModel',
    research: 'openAiResearchModel',
  },
  openrouter: {
    artifact: 'artifactModel',
    artifactInteractive: 'artifactInteractiveModel',
    assessment: 'assessmentModel',
    context: 'contextModel',
    lesson: 'lessonModel',
    progress: 'progressModel',
    research: 'researchModel',
  },
};

const REASONING_EFFORT_FIELDS: Record<
  Exclude<TextModelSlot, 'research'>,
  keyof GlobalModelConfig
> = {
  artifact: 'artifactReasoningEffort',
  artifactInteractive: 'artifactInteractiveReasoningEffort',
  assessment: 'assessmentReasoningEffort',
  context: 'contextReasoningEffort',
  lesson: 'lessonReasoningEffort',
  progress: 'progressReasoningEffort',
};

export const resolveTextModelConfig = (
  config: GlobalModelConfig,
  slot: TextModelSlot
): { model: string; reasoningEffort: ReasoningEffort } => {
  const model = config[PROVIDER_MODEL_FIELDS[config.aiProvider][slot]];
  const reasoningEffort = slot === 'research' ? 'none' : config[REASONING_EFFORT_FIELDS[slot]];
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
  requestedProvider: unknown
): Promise<GlobalModelConfig> => {
  const config = await getResolvedGlobalModelConfig();
  return isAiProvider(requestedProvider) ? { ...config, aiProvider: requestedProvider } : config;
};

const buildPatchedGlobalModelConfig = (patch: GlobalModelConfigPatch): GlobalModelConfig => ({
  ...activeModelConfig,
  ...(isAiProvider(patch.aiProvider) ? { aiProvider: patch.aiProvider } : {}),
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
  ...(readConfigValue(patch.ttsModel) ? { ttsModel: readConfigValue(patch.ttsModel) } : {}),
  ...(readConfigValue(patch.ttsVoice) ? { ttsVoice: readConfigValue(patch.ttsVoice) } : {}),
  updatedAt: new Date().toISOString(),
});

export const patchGlobalModelConfig = (patch: GlobalModelConfigPatch): GlobalModelConfig => {
  activeModelConfig = buildPatchedGlobalModelConfig(patch);
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
  codex_lesson_model: config.codexLessonModel,
  codex_progress_model: config.codexProgressModel,
  codex_research_model: config.codexResearchModel,
  context_model: config.contextModel,
  context_reasoning_effort: config.contextReasoningEffort,
  image_model: config.imageModel,
  lesson_model: config.lessonModel,
  lesson_reasoning_effort: config.lessonReasoningEffort,
  openai_assessment_model: config.openAiAssessmentModel,
  openai_artifact_model: config.openAiArtifactModel,
  openai_artifact_interactive_model: config.openAiArtifactInteractiveModel,
  openai_context_model: config.openAiContextModel,
  openai_image_model: config.openAiImageModel,
  openai_lesson_model: config.openAiLessonModel,
  openai_progress_model: config.openAiProgressModel,
  openai_research_model: config.openAiResearchModel,
  progress_model: config.progressModel,
  progress_reasoning_effort: config.progressReasoningEffort,
  research_model: config.researchModel,
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
  const config = buildPatchedGlobalModelConfig(patch);
  if (!isPersistentModelConfigEnabled()) {
    activeModelConfig = config;
    persistedModelConfigPromise = null;
    return config;
  }

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
