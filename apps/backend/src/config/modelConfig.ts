export interface GlobalModelConfig {
  assessmentModel: string;
  contextModel: string;
  lessonModel: string;
  ttsModel: string;
  ttsVoice: string;
  updatedAt: string;
}

export type GlobalModelConfigPatch = Partial<
  Pick<
    GlobalModelConfig,
    'assessmentModel' | 'contextModel' | 'lessonModel' | 'ttsModel' | 'ttsVoice'
  >
>;

const DEFAULT_MODEL_CONFIG: Omit<GlobalModelConfig, 'updatedAt'> = {
  assessmentModel: process.env.MODEL_ASSESSMENT || 'google/gemini-3.1-flash-lite',
  contextModel: process.env.MODEL_CONTEXT || 'google/gemini-3.1-flash-lite',
  lessonModel: process.env.MODEL_LESSON || 'openai/gpt-5.4-mini',
  ttsModel: process.env.MODEL_TTS || 'openai/gpt-4o-mini-tts',
  ttsVoice: process.env.TTS_VOICE || 'coral',
};

let activeModelConfig: GlobalModelConfig = {
  ...DEFAULT_MODEL_CONFIG,
  updatedAt: new Date(0).toISOString(),
};
let persistedModelConfigPromise: Promise<GlobalModelConfig> | null = null;

interface PersistedModelConfigRow {
  id?: 'global';
  assessment_model?: string;
  context_model?: string;
  lesson_model?: string;
  tts_model?: string;
  tts_voice?: string;
  updated_at?: string;
}

const readConfigValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

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
    ...(readConfigValue(patch.contextModel)
      ? { contextModel: readConfigValue(patch.contextModel) }
      : {}),
    ...(readConfigValue(patch.lessonModel)
      ? { lessonModel: readConfigValue(patch.lessonModel) }
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
  context_model: config.contextModel,
  lesson_model: config.lessonModel,
  tts_model: config.ttsModel,
  tts_voice: config.ttsVoice,
  updated_at: config.updatedAt,
});

const readPersistedModelConfig = (row: PersistedModelConfigRow): GlobalModelConfig => ({
  assessmentModel: readConfigValue(row.assessment_model) || activeModelConfig.assessmentModel,
  contextModel: readConfigValue(row.context_model) || activeModelConfig.contextModel,
  lessonModel: readConfigValue(row.lesson_model) || activeModelConfig.lessonModel,
  ttsModel: readConfigValue(row.tts_model) || activeModelConfig.ttsModel,
  ttsVoice: readConfigValue(row.tts_voice) || activeModelConfig.ttsVoice,
  updatedAt: readConfigValue(row.updated_at) || activeModelConfig.updatedAt,
});

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
