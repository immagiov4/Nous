export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export const DEFAULT_TTS_MODEL = 'x-ai/grok-voice-tts-1.0';
export const DEFAULT_TTS_VOICE = 'Ara';

const UNAVAILABLE_TTS_MODELS = new Set([
  'openai/gpt-4o-mini-tts',
  'openai/gpt-4o-mini-tts-2025-12-15',
  'mistralai/voxtral-mini-tts-2603',
]);

export interface GlobalModelConfig {
  assessmentModel: string;
  assessmentReasoningEffort: ReasoningEffort;
  contextModel: string;
  contextReasoningEffort: ReasoningEffort;
  lessonModel: string;
  lessonReasoningEffort: ReasoningEffort;
  ttsModel: string;
  ttsVoice: string;
  updatedAt: string;
}

export type GlobalModelConfigPatch = Partial<
  Pick<
    GlobalModelConfig,
    | 'assessmentModel'
    | 'assessmentReasoningEffort'
    | 'contextModel'
    | 'contextReasoningEffort'
    | 'lessonModel'
    | 'lessonReasoningEffort'
    | 'ttsModel'
    | 'ttsVoice'
  >
>;

const DEFAULT_MODEL_CONFIG: Omit<GlobalModelConfig, 'updatedAt'> = {
  assessmentModel: process.env.MODEL_ASSESSMENT || 'google/gemini-3.1-flash-lite',
  assessmentReasoningEffort: 'medium',
  contextModel: process.env.MODEL_CONTEXT || 'google/gemini-3.1-flash-lite',
  contextReasoningEffort: 'medium',
  lessonModel: process.env.MODEL_LESSON || 'openai/gpt-5.4-mini',
  lessonReasoningEffort: 'medium',
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
  assessment_model?: string;
  assessment_reasoning_effort?: string;
  context_model?: string;
  context_reasoning_effort?: string;
  lesson_model?: string;
  lesson_reasoning_effort?: string;
  tts_model?: string;
  tts_voice?: string;
  updated_at?: string;
}

const readConfigValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const REASONING_EFFORTS = new Set<ReasoningEffort>(['none', 'low', 'medium', 'high']);

export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && REASONING_EFFORTS.has(value as ReasoningEffort);

const readReasoningEffort = (value: unknown, fallback: ReasoningEffort): ReasoningEffort =>
  isReasoningEffort(value) ? value : fallback;

export const getGlobalModelConfig = (): GlobalModelConfig => activeModelConfig;

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

export const patchGlobalModelConfig = (patch: GlobalModelConfigPatch): GlobalModelConfig => {
  const nextConfig = {
    ...activeModelConfig,
    ...(readConfigValue(patch.assessmentModel)
      ? { assessmentModel: readConfigValue(patch.assessmentModel) }
      : {}),
    ...(isReasoningEffort(patch.assessmentReasoningEffort)
      ? { assessmentReasoningEffort: patch.assessmentReasoningEffort }
      : {}),
    ...(readConfigValue(patch.contextModel)
      ? { contextModel: readConfigValue(patch.contextModel) }
      : {}),
    ...(isReasoningEffort(patch.contextReasoningEffort)
      ? { contextReasoningEffort: patch.contextReasoningEffort }
      : {}),
    ...(readConfigValue(patch.lessonModel)
      ? { lessonModel: readConfigValue(patch.lessonModel) }
      : {}),
    ...(isReasoningEffort(patch.lessonReasoningEffort)
      ? { lessonReasoningEffort: patch.lessonReasoningEffort }
      : {}),
    ...(readConfigValue(patch.ttsModel) ? { ttsModel: readConfigValue(patch.ttsModel) } : {}),
    ...(readConfigValue(patch.ttsVoice) ? { ttsVoice: readConfigValue(patch.ttsVoice) } : {}),
    updatedAt: new Date().toISOString(),
  };

  activeModelConfig = nextConfig;
  return activeModelConfig;
};

const isPersistentModelConfigEnabled = (): boolean =>
  process.env.PROJECT_STORAGE_DRIVER === 'postgres' &&
  Boolean(process.env.SUPABASE_URL?.trim()) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());

const getSupabaseRestConfig = () => ({
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '',
  supabaseUrl: (process.env.SUPABASE_URL?.trim() || '').replace(/\/$/, ''),
});

const buildPersistedModelConfig = (config: GlobalModelConfig): PersistedModelConfigRow => ({
  id: 'global',
  assessment_model: config.assessmentModel,
  assessment_reasoning_effort: config.assessmentReasoningEffort,
  context_model: config.contextModel,
  context_reasoning_effort: config.contextReasoningEffort,
  lesson_model: config.lessonModel,
  lesson_reasoning_effort: config.lessonReasoningEffort,
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
    assessmentModel: readConfigValue(row.assessment_model) || activeModelConfig.assessmentModel,
    assessmentReasoningEffort: readReasoningEffort(
      row.assessment_reasoning_effort,
      activeModelConfig.assessmentReasoningEffort
    ),
    contextModel: readConfigValue(row.context_model) || activeModelConfig.contextModel,
    contextReasoningEffort: readReasoningEffort(
      row.context_reasoning_effort,
      activeModelConfig.contextReasoningEffort
    ),
    lessonModel: readConfigValue(row.lesson_model) || activeModelConfig.lessonModel,
    lessonReasoningEffort: readReasoningEffort(
      row.lesson_reasoning_effort,
      activeModelConfig.lessonReasoningEffort
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
  const config = patchGlobalModelConfig(patch);
  if (!isPersistentModelConfigEnabled()) {
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
