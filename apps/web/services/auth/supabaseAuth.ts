export interface SupabaseUserSession {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  user?: {
    email?: string;
    id: string;
  };
}

interface SupabaseAuthResponse {
  access_token?: string;
  expires_at?: number;
  refresh_token?: string;
  user?: {
    email?: string;
    id?: string;
  };
}

const SUPABASE_SESSION_STORAGE_KEY = 'nousSupabaseSession';
const SESSION_EXPIRY_SKEW_SECONDS = 30;
const LOCAL_AUTH_MODE = 'local-bypass';
const SUPABASE_AUTH_MODE = 'supabase';
let memorySession: string | null = null;

export const getFrontendAuthMode = (): 'local-bypass' | 'supabase' | 'unconfigured' => {
  const configuredMode = import.meta.env.VITE_AUTH_MODE?.trim();
  if (configuredMode === SUPABASE_AUTH_MODE || configuredMode === LOCAL_AUTH_MODE) {
    return configuredMode;
  }

  return import.meta.env.MODE === 'test' ? LOCAL_AUTH_MODE : 'unconfigured';
};

export const isSupabaseAuthEnabled = (): boolean => getFrontendAuthMode() === SUPABASE_AUTH_MODE;

export const isLocalAuthBypassEnabled = (): boolean =>
  getFrontendAuthMode() === LOCAL_AUTH_MODE &&
  (import.meta.env.MODE === 'test' || import.meta.env.VITE_LOCAL_DEV_PROFILE === 'true');

const getStorage = (): Storage | null => {
  if (typeof window !== 'undefined') {
    return window.localStorage;
  }

  return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
};

const getSupabaseAuthConfig = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !anonKey) {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required for Supabase Auth.');
  }

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ''),
    anonKey,
  };
};

const normalizeSession = (response: SupabaseAuthResponse): SupabaseUserSession => {
  if (!response.access_token) {
    throw new Error('Supabase Auth did not return an access token.');
  }

  return {
    accessToken: response.access_token,
    expiresAt: response.expires_at,
    refreshToken: response.refresh_token,
    user: response.user?.id
      ? {
          id: response.user.id,
          email: response.user.email,
        }
      : undefined,
  };
};

const isSessionExpired = (session: SupabaseUserSession): boolean => {
  if (!session.expiresAt) {
    return false;
  }

  return session.expiresAt <= Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SKEW_SECONDS;
};

export const readSupabaseSession = (): SupabaseUserSession | null => {
  const storage = getStorage();
  const rawSession = storage?.getItem(SUPABASE_SESSION_STORAGE_KEY) ?? memorySession;
  if (!rawSession) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawSession) as SupabaseUserSession;
    if (!parsed.accessToken || isSessionExpired(parsed)) {
      clearSupabaseSession();
      return null;
    }

    return parsed;
  } catch {
    storage?.removeItem(SUPABASE_SESSION_STORAGE_KEY);
    memorySession = null;
    return null;
  }
};

export const saveSupabaseSession = (session: SupabaseUserSession): void => {
  const serializedSession = JSON.stringify(session);
  const storage = getStorage();
  if (storage) {
    storage.setItem(SUPABASE_SESSION_STORAGE_KEY, serializedSession);
    memorySession = null;
    return;
  }

  memorySession = serializedSession;
};

export const clearSupabaseSession = (): void => {
  getStorage()?.removeItem(SUPABASE_SESSION_STORAGE_KEY);
  memorySession = null;
};

export const getSupabaseAccessToken = (): string | null =>
  readSupabaseSession()?.accessToken || null;

export const getSupabaseAuthHeaders = (): HeadersInit => {
  const accessToken = getSupabaseAccessToken();
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
};

export const signInWithPassword = async ({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<SupabaseUserSession> => {
  const { anonKey, supabaseUrl } = getSupabaseAuthConfig();
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error('Accesso non riuscito.');
  }

  const session = normalizeSession((await response.json()) as SupabaseAuthResponse);
  saveSupabaseSession(session);
  return session;
};

export const sendMagicLink = async (email: string): Promise<void> => {
  const { anonKey, supabaseUrl } = getSupabaseAuthConfig();
  const emailRedirectTo =
    typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '';
  const response = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      type: 'magiclink',
      options: emailRedirectTo ? { email_redirect_to: emailRedirectTo } : undefined,
    }),
  });

  if (!response.ok) {
    throw new Error('Invio magic link non riuscito.');
  }
};

export const consumeSupabaseSessionFromUrl = (): SupabaseUserSession | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const accessToken = params.get('access_token');
  if (!accessToken) {
    return readSupabaseSession();
  }

  const session: SupabaseUserSession = {
    accessToken,
    refreshToken: params.get('refresh_token') || undefined,
    expiresAt: Number.parseInt(params.get('expires_at') || '', 10) || undefined,
  };
  saveSupabaseSession(session);
  window.history.replaceState(
    null,
    document.title,
    window.location.pathname + window.location.search
  );
  return session;
};
