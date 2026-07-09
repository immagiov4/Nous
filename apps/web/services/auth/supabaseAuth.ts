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
  expires_in?: number;
  refresh_token?: string;
  user?: {
    email?: string;
    id?: string;
  };
}

const SUPABASE_SESSION_STORAGE_KEY = 'nousSupabaseSession';
const SUPABASE_SESSION_CHANGE_EVENT = 'nous:supabase-session-change';
const SESSION_EXPIRY_SKEW_SECONDS = 30;
export const SUPABASE_SESSION_REFRESH_RETRY_MS = 30_000;
const LOCAL_AUTH_MODE = 'local-bypass';
const SUPABASE_AUTH_MODE = 'supabase';
let memorySession: string | null = null;
let refreshSessionPromise: Promise<SupabaseUserSession | null> | null = null;

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

const normalizeSession = (
  response: SupabaseAuthResponse,
  previousSession?: SupabaseUserSession
): SupabaseUserSession => {
  if (!response.access_token) {
    throw new Error('Supabase Auth did not return an access token.');
  }

  return {
    accessToken: response.access_token,
    expiresAt:
      response.expires_at ||
      (response.expires_in
        ? Math.floor(Date.now() / 1000) + response.expires_in
        : previousSession?.expiresAt),
    refreshToken: response.refresh_token || previousSession?.refreshToken,
    user: response.user?.id
      ? {
          id: response.user.id,
          email: response.user.email,
        }
      : previousSession?.user,
  };
};

const isSessionExpired = (session: SupabaseUserSession): boolean => {
  if (!session.expiresAt) {
    return false;
  }

  return session.expiresAt <= Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SKEW_SECONDS;
};

const notifySupabaseSessionChange = (): void => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SUPABASE_SESSION_CHANGE_EVENT));
  }
};

export const readSupabaseSession = (): SupabaseUserSession | null => {
  const storage = getStorage();
  const rawSession = storage?.getItem(SUPABASE_SESSION_STORAGE_KEY) ?? memorySession;
  if (!rawSession) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawSession) as SupabaseUserSession;
    if (!parsed.accessToken || (isSessionExpired(parsed) && !parsed.refreshToken)) {
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
    notifySupabaseSessionChange();
    return;
  }

  memorySession = serializedSession;
  notifySupabaseSessionChange();
};

export const clearSupabaseSession = (): void => {
  getStorage()?.removeItem(SUPABASE_SESSION_STORAGE_KEY);
  memorySession = null;
  notifySupabaseSessionChange();
};

export const getSupabaseAccessToken = (): string | null => {
  const session = readSupabaseSession();
  return session && !isSessionExpired(session) ? session.accessToken : null;
};

export const getSupabaseAuthHeaders = (): HeadersInit => {
  const accessToken = getSupabaseAccessToken();
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
};

export const mergeSupabaseAuthHeaders = (headers: HeadersInit | undefined = {}): HeadersInit => ({
  ...Object.fromEntries(new Headers(headers).entries()),
  ...getSupabaseAuthHeaders(),
});

const requestRefreshedSupabaseSession = async (
  session: SupabaseUserSession
): Promise<SupabaseUserSession | null> => {
  if (!session.refreshToken) {
    clearSupabaseSession();
    return null;
  }

  const { anonKey, supabaseUrl } = getSupabaseAuthConfig();
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });

  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      clearSupabaseSession();
      return null;
    }
    throw new Error('Aggiornamento sessione temporaneamente non disponibile.');
  }

  try {
    const refreshedSession = normalizeSession(
      (await response.json()) as SupabaseAuthResponse,
      session
    );
    saveSupabaseSession(refreshedSession);
    return refreshedSession;
  } catch {
    clearSupabaseSession();
    return null;
  }
};

export const refreshSupabaseSession = (): Promise<SupabaseUserSession | null> => {
  if (refreshSessionPromise) {
    return refreshSessionPromise;
  }

  const session = readSupabaseSession();
  if (!session?.refreshToken) {
    clearSupabaseSession();
    return Promise.resolve(null);
  }

  refreshSessionPromise = requestRefreshedSupabaseSession(session).finally(() => {
    refreshSessionPromise = null;
  });
  return refreshSessionPromise;
};

export const getValidSupabaseSession = async (): Promise<SupabaseUserSession | null> => {
  const session = readSupabaseSession();
  if (!session) {
    return null;
  }

  return isSessionExpired(session) ? refreshSupabaseSession() : session;
};

const buildAuthenticatedHeaders = (
  headers: HeadersInit | undefined,
  session: SupabaseUserSession | null
): HeadersInit => ({
  ...Object.fromEntries(new Headers(headers).entries()),
  ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
});

export const fetchWithSupabaseAuth = async (
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> => {
  const session = await getValidSupabaseSession();
  const sendRequest = (requestSession: SupabaseUserSession | null) =>
    fetch(input, {
      ...init,
      headers: buildAuthenticatedHeaders(init.headers, requestSession),
    });

  const response = await sendRequest(session);
  if (response.status !== 401) {
    return response;
  }

  const refreshedSession = await refreshSupabaseSession();
  if (!refreshedSession) {
    return response;
  }

  const retryResponse = await sendRequest(refreshedSession);
  if (retryResponse.status === 401) {
    clearSupabaseSession();
  }
  return retryResponse;
};

export const scheduleSupabaseSessionRefresh = (
  session: SupabaseUserSession,
  refresh: () => void | Promise<void>
): (() => void) => {
  if (!session.expiresAt || !session.refreshToken) {
    return () => {};
  }

  const refreshAt = session.expiresAt * 1000 - SESSION_EXPIRY_SKEW_SECONDS * 1000;
  const timeoutId = globalThis.setTimeout(
    () => {
      void refresh();
    },
    Math.max(0, refreshAt - Date.now())
  );
  return () => globalThis.clearTimeout(timeoutId);
};

export const subscribeToSupabaseSession = (
  listener: (session: SupabaseUserSession | null) => void
): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleSessionChange = () => listener(readSupabaseSession());
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === SUPABASE_SESSION_STORAGE_KEY) {
      handleSessionChange();
    }
  };
  window.addEventListener(SUPABASE_SESSION_CHANGE_EVENT, handleSessionChange);
  window.addEventListener('storage', handleStorageChange);
  return () => {
    window.removeEventListener(SUPABASE_SESSION_CHANGE_EVENT, handleSessionChange);
    window.removeEventListener('storage', handleStorageChange);
  };
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
