import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';

export interface CodexAccountStatus {
  email?: string;
  requiresOpenaiAuth: boolean;
  type?: string;
}

export interface CodexModelStatus {
  defaultReasoningEffort?: string;
  model: string;
  supportedReasoningEfforts: string[];
}

export interface CodexProviderStatus {
  account: CodexAccountStatus | null;
  enabled: boolean;
  models: CodexModelStatus[];
}

export interface CodexDeviceLogin {
  loginId?: string;
  type?: string;
  userCode?: string;
  verificationUrl?: string;
}

interface CodexRequestError extends Error {
  status?: number;
}

const requestCodex = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/codex${path}`, init);
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    const error = new Error(
      payload.error || 'Codex non ha completato l’operazione.'
    ) as CodexRequestError;
    error.status = response.status;
    throw error;
  }
  return payload;
};

export const loadCodexProviderStatus = async (): Promise<CodexProviderStatus> => {
  const response = await requestCodex<{ success: true } & CodexProviderStatus>('/status');
  return { account: response.account, enabled: response.enabled, models: response.models };
};

export const startCodexDeviceLogin = async (): Promise<CodexDeviceLogin> => {
  const response = await requestCodex<{ login: CodexDeviceLogin }>('/login', { method: 'POST' });
  return response.login;
};

export const cancelCodexDeviceLogin = async (loginId: string): Promise<void> => {
  await requestCodex('/login/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId }),
  });
};

export const logoutCodexProvider = async (): Promise<void> => {
  await requestCodex('/logout', { method: 'POST' });
};
