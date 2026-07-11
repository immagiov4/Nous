import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';

export type AdminReasoningEffort = 'none' | 'low' | 'medium' | 'high';
export type AdminAiProvider = 'codex' | 'openai' | 'openrouter';

export interface AdminUser {
  banned_until?: string | null;
  email?: string;
  id: string;
  app_metadata?: {
    role?: string;
  };
}

export interface AdminModelConfig {
  aiProvider: AdminAiProvider;
  assessmentModel: string;
  assessmentReasoningEffort: AdminReasoningEffort;
  codexAssessmentModel: string;
  codexContextModel: string;
  codexLessonModel: string;
  codexProgressModel: string;
  codexResearchModel: string;
  contextModel: string;
  contextReasoningEffort: AdminReasoningEffort;
  imageModel: string;
  lessonModel: string;
  lessonReasoningEffort: AdminReasoningEffort;
  openAiAssessmentModel: string;
  openAiContextModel: string;
  openAiImageModel: string;
  openAiLessonModel: string;
  openAiProgressModel: string;
  openAiResearchModel: string;
  progressModel: string;
  progressReasoningEffort: AdminReasoningEffort;
  researchModel: string;
  ttsModel: string;
  ttsVoice: string;
  updatedAt: string;
}

export type AdminModelConfigPatch = Partial<
  Pick<
    AdminModelConfig,
    | 'aiProvider'
    | 'assessmentModel'
    | 'assessmentReasoningEffort'
    | 'codexAssessmentModel'
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

export const DEFAULT_ADMIN_MODEL_CONFIG: AdminModelConfig = {
  aiProvider: 'openrouter',
  assessmentModel: 'google/gemini-3.1-flash-lite',
  assessmentReasoningEffort: 'medium',
  codexAssessmentModel: 'gpt-5.6-luna',
  codexContextModel: 'gpt-5.6-luna',
  codexLessonModel: 'gpt-5.6-terra',
  codexProgressModel: 'gpt-5.6-luna',
  codexResearchModel: 'gpt-5.6-terra',
  contextModel: 'google/gemini-3.1-flash-lite',
  contextReasoningEffort: 'medium',
  imageModel: 'google/gemini-3.1-flash-lite-image',
  lessonModel: 'openai/gpt-5.4-mini',
  lessonReasoningEffort: 'medium',
  openAiAssessmentModel: 'gpt-5.6-luna',
  openAiContextModel: 'gpt-5.6-luna',
  openAiImageModel: 'gpt-image-2',
  openAiLessonModel: 'gpt-5.6-terra',
  openAiProgressModel: 'gpt-5.6-luna',
  openAiResearchModel: 'gpt-5.6-terra',
  progressModel: 'google/gemini-3.1-flash-lite',
  progressReasoningEffort: 'low',
  researchModel: 'perplexity/sonar-pro-search',
  ttsModel: 'x-ai/grok-voice-tts-1.0',
  ttsVoice: 'Ara',
  updatedAt: '',
};

const readConfigValue = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const ADMIN_REASONING_EFFORTS = new Set<AdminReasoningEffort>(['none', 'low', 'medium', 'high']);
const ADMIN_AI_PROVIDERS = new Set<AdminAiProvider>(['codex', 'openai', 'openrouter']);

const readAiProvider = (value: unknown): AdminAiProvider =>
  typeof value === 'string' && ADMIN_AI_PROVIDERS.has(value as AdminAiProvider)
    ? (value as AdminAiProvider)
    : DEFAULT_ADMIN_MODEL_CONFIG.aiProvider;

const readReasoningEffort = (
  value: unknown,
  fallback: AdminReasoningEffort
): AdminReasoningEffort =>
  typeof value === 'string' && ADMIN_REASONING_EFFORTS.has(value as AdminReasoningEffort)
    ? (value as AdminReasoningEffort)
    : fallback;

const normalizeAdminModelConfig = (
  config: Partial<AdminModelConfig> | null | undefined
): AdminModelConfig => ({
  aiProvider: readAiProvider(config?.aiProvider),
  assessmentModel: readConfigValue(
    config?.assessmentModel,
    DEFAULT_ADMIN_MODEL_CONFIG.assessmentModel
  ),
  assessmentReasoningEffort: readReasoningEffort(
    config?.assessmentReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.assessmentReasoningEffort
  ),
  codexAssessmentModel: readConfigValue(
    config?.codexAssessmentModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexAssessmentModel
  ),
  codexContextModel: readConfigValue(
    config?.codexContextModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexContextModel
  ),
  codexLessonModel: readConfigValue(
    config?.codexLessonModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexLessonModel
  ),
  codexProgressModel: readConfigValue(
    config?.codexProgressModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexProgressModel
  ),
  codexResearchModel: readConfigValue(
    config?.codexResearchModel,
    DEFAULT_ADMIN_MODEL_CONFIG.codexResearchModel
  ),
  contextModel: readConfigValue(config?.contextModel, DEFAULT_ADMIN_MODEL_CONFIG.contextModel),
  contextReasoningEffort: readReasoningEffort(
    config?.contextReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.contextReasoningEffort
  ),
  imageModel: readConfigValue(config?.imageModel, DEFAULT_ADMIN_MODEL_CONFIG.imageModel),
  lessonModel: readConfigValue(config?.lessonModel, DEFAULT_ADMIN_MODEL_CONFIG.lessonModel),
  lessonReasoningEffort: readReasoningEffort(
    config?.lessonReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.lessonReasoningEffort
  ),
  openAiAssessmentModel: readConfigValue(
    config?.openAiAssessmentModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiAssessmentModel
  ),
  openAiContextModel: readConfigValue(
    config?.openAiContextModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiContextModel
  ),
  openAiImageModel: readConfigValue(
    config?.openAiImageModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiImageModel
  ),
  openAiLessonModel: readConfigValue(
    config?.openAiLessonModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiLessonModel
  ),
  openAiProgressModel: readConfigValue(
    config?.openAiProgressModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiProgressModel
  ),
  openAiResearchModel: readConfigValue(
    config?.openAiResearchModel,
    DEFAULT_ADMIN_MODEL_CONFIG.openAiResearchModel
  ),
  progressModel: readConfigValue(config?.progressModel, DEFAULT_ADMIN_MODEL_CONFIG.progressModel),
  progressReasoningEffort: readReasoningEffort(
    config?.progressReasoningEffort,
    DEFAULT_ADMIN_MODEL_CONFIG.progressReasoningEffort
  ),
  researchModel: readConfigValue(config?.researchModel, DEFAULT_ADMIN_MODEL_CONFIG.researchModel),
  ttsModel: readConfigValue(config?.ttsModel, DEFAULT_ADMIN_MODEL_CONFIG.ttsModel),
  ttsVoice: readConfigValue(config?.ttsVoice, DEFAULT_ADMIN_MODEL_CONFIG.ttsVoice),
  updatedAt: readConfigValue(config?.updatedAt, DEFAULT_ADMIN_MODEL_CONFIG.updatedAt),
});

const readAdminResponse = async <T>(response: Response): Promise<T> => {
  const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(data.error || response.statusText || 'Richiesta admin non riuscita.');
  }

  return data;
};

const requestAdmin = async <T>(path: string, init: RequestInit = {}): Promise<T> =>
  readAdminResponse<T>(
    await fetchWithSupabaseAuth(`${getBackendUrl()}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  );

export const listAdminUsers = async (): Promise<AdminUser[]> => {
  const response = await requestAdmin<{ users: AdminUser[] }>('/api/admin/users');
  return response.users || [];
};

export const createAdminUser = async ({
  email,
  password,
  role,
}: {
  email: string;
  password: string;
  role: 'admin' | 'user';
}): Promise<AdminUser> => {
  const response = await requestAdmin<{ user: AdminUser }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, role }),
  });
  return response.user;
};

export const sendAdminMagicLink = async (userId: string): Promise<void> => {
  await requestAdmin(`/api/admin/users/${encodeURIComponent(userId)}/magic-link`, {
    method: 'POST',
  });
};

export const updateAdminUser = async (
  userId: string,
  patch: { disabled?: boolean; password?: string; role?: 'admin' | 'user' }
): Promise<AdminUser> => {
  const response = await requestAdmin<{ user: AdminUser }>(
    `/api/admin/users/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }
  );
  return response.user;
};

export const getAdminModelConfig = async (): Promise<AdminModelConfig> => {
  const response = await requestAdmin<{ config: AdminModelConfig }>('/api/admin/model-config');
  return normalizeAdminModelConfig(response.config);
};

export const patchAdminModelConfig = async (
  patch: AdminModelConfigPatch
): Promise<AdminModelConfig> => {
  const response = await requestAdmin<{ config: AdminModelConfig }>('/api/admin/model-config', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return normalizeAdminModelConfig(response.config);
};
