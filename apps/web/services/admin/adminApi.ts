import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';

export interface AdminUser {
  banned_until?: string | null;
  email?: string;
  id: string;
  app_metadata?: {
    role?: string;
  };
}

export interface AdminModelConfig {
  assessmentModel: string;
  contextModel: string;
  lessonModel: string;
  ttsModel: string;
  ttsVoice: string;
  updatedAt: string;
}

export type AdminModelConfigPatch = Partial<
  Pick<
    AdminModelConfig,
    'assessmentModel' | 'contextModel' | 'lessonModel' | 'ttsModel' | 'ttsVoice'
  >
>;

export const DEFAULT_ADMIN_MODEL_CONFIG: AdminModelConfig = {
  assessmentModel: 'google/gemini-3.1-flash-lite',
  contextModel: 'google/gemini-3.1-flash-lite',
  lessonModel: 'openai/gpt-5.4-mini',
  ttsModel: 'openai/gpt-4o-mini-tts',
  ttsVoice: 'coral',
  updatedAt: '',
};

const readConfigValue = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;

const normalizeAdminModelConfig = (
  config: Partial<AdminModelConfig> | null | undefined
): AdminModelConfig => ({
  assessmentModel: readConfigValue(
    config?.assessmentModel,
    DEFAULT_ADMIN_MODEL_CONFIG.assessmentModel
  ),
  contextModel: readConfigValue(config?.contextModel, DEFAULT_ADMIN_MODEL_CONFIG.contextModel),
  lessonModel: readConfigValue(config?.lessonModel, DEFAULT_ADMIN_MODEL_CONFIG.lessonModel),
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
