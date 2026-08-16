import { TransientRequestError } from '../core/errorMessage.ts';
import { logBackendFailureCorrelationId } from '../feedback/browserDiagnostics.ts';
import { getBackendUrl } from '../openrouter/config.ts';
import { getNousRuntimeConfig } from '../runtimeConfig.ts';

export interface SupabaseAccount {
  email?: string;
  id: string;
  passwordSetupRequired?: boolean;
  providers?: string[];
}

export interface SupabaseUserSession {
  accessToken: string;
  authAction?: 'invite' | 'recovery';
  expiresAt?: number;
  refreshToken?: string;
  user?: SupabaseAccount;
}

export type SupabaseAuthCallbackResult =
  | { status: 'none'; session: SupabaseUserSession | null }
  | { status: 'success'; session: SupabaseUserSession }
  | { status: 'error'; session: null };

interface SupabaseAuthUserResponse {
  app_metadata?: {
    password_setup_required?: unknown;
    provider?: unknown;
    providers?: unknown;
  };
  email?: string;
  id?: string;
  identities?: Array<{ provider?: unknown }>;
}

export type SupabasePasswordSetupErrorReason = 'expired' | 'retryable' | 'weak-password';

export class SupabasePasswordSetupError extends Error {
  constructor(public readonly reason: SupabasePasswordSetupErrorReason) {
    super(reason);
  }
}

interface SupabaseAuthResponse {
  access_token?: string;
  expires_at?: number;
  expires_in?: number;
  refresh_token?: string;
  type?: unknown;
  user?: SupabaseAuthUserResponse;
}

const SUPABASE_SESSION_STORAGE_KEY = 'nousSupabaseSession';
const SUPABASE_SESSION_CHANGE_EVENT = 'nous:supabase-session-change';
const SESSION_EXPIRY_SKEW_SECONDS = 30;
export const SUPABASE_SESSION_REFRESH_RETRY_MS = 30_000;
const SUPABASE_REFRESH_UNAVAILABLE_MESSAGE =
  'Aggiornamento sessione temporaneamente non disponibile.';
const LOCAL_AUTH_MODE = 'local-bypass';
const SUPABASE_AUTH_MODE = 'supabase';
let memorySession: string | null = null;
let sessionGeneration = 0;
let refreshSessionRequest:
  | {
      generation: number;
      promise: Promise<SupabaseUserSession | null>;
      session: SupabaseUserSession;
    }
  | undefined;

export const getFrontendAuthMode = (): 'local-bypass' | 'supabase' | 'unconfigured' => {
  const configuredMode = getNousRuntimeConfig().authMode || import.meta.env.VITE_AUTH_MODE?.trim();
  if (configuredMode === SUPABASE_AUTH_MODE || configuredMode === LOCAL_AUTH_MODE) {
    return configuredMode;
  }

  return import.meta.env.MODE === 'test' ? LOCAL_AUTH_MODE : 'unconfigured';
};

export const isSupabaseAuthEnabled = (): boolean => getFrontendAuthMode() === SUPABASE_AUTH_MODE;

export const isLocalAuthBypassEnabled = (): boolean =>
  getFrontendAuthMode() === LOCAL_AUTH_MODE &&
  (import.meta.env.MODE === 'test' || import.meta.env.VITE_LOCAL_DEV_PROFILE === 'true');

const isStorage = (candidate: unknown): candidate is Storage =>
  typeof candidate === 'object' &&
  candidate !== null &&
  typeof (candidate as Partial<Storage>).getItem === 'function' &&
  typeof (candidate as Partial<Storage>).setItem === 'function' &&
  typeof (candidate as Partial<Storage>).removeItem === 'function';

const getStorage = (): Storage | null => {
  try {
    const candidate =
      typeof globalThis.window !== 'undefined'
        ? globalThis.window.localStorage
        : globalThis.localStorage;

    // Some runtimes expose a partial localStorage global that is not browser Storage.
    return isStorage(candidate) ? candidate : null;
  } catch {
    return null;
  }
};

interface BrowserLocationLike {
  hostname: string;
}

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '::1' ||
  hostname === '[::1]';

export const resolveBrowserReachableSupabaseUrl = (
  configuredUrl: string,
  browserLocation: BrowserLocationLike | null = typeof globalThis.window === 'undefined'
    ? null
    : globalThis.window.location
): string => {
  const normalizedUrl = configuredUrl.replace(/\/$/, '');
  if (!browserLocation || isLoopbackHostname(browserLocation.hostname)) {
    return normalizedUrl;
  }

  const parsedUrl = new URL(normalizedUrl);
  if (!isLoopbackHostname(parsedUrl.hostname)) {
    return normalizedUrl;
  }

  parsedUrl.hostname = browserLocation.hostname;
  return parsedUrl.toString().replace(/\/$/, '');
};

const getSupabaseAuthConfig = () => {
  const runtimeConfig = getNousRuntimeConfig();
  const supabaseUrl = runtimeConfig.supabaseUrl || import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = runtimeConfig.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !anonKey) {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required for Supabase Auth.');
  }

  return {
    supabaseUrl: resolveBrowserReachableSupabaseUrl(supabaseUrl),
    anonKey,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const decodeJwtPayload = (accessToken: string): Record<string, unknown> | null => {
  try {
    const encodedPayload = accessToken.split('.')[1];
    if (!encodedPayload) {
      return null;
    }
    const normalizedPayload = encodedPayload.replaceAll('-', '+').replaceAll('_', '/');
    const binary = globalThis.atob(
      normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, '=')
    );
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
};

export const readSupabaseAccessRole = (accessToken: string): 'admin' | 'user' | null => {
  const payload = decodeJwtPayload(accessToken);
  const appMetadata = payload && isRecord(payload.app_metadata) ? payload.app_metadata : null;
  if (!appMetadata || typeof appMetadata.role !== 'string') return null;
  return appMetadata.role === 'admin' ? 'admin' : 'user';
};

const readAccountFromAccessToken = (accessToken: string): SupabaseAuthUserResponse | null => {
  const payload = decodeJwtPayload(accessToken);
  const id = payload && typeof payload.sub === 'string' ? payload.sub : undefined;
  if (!payload || !id) {
    return null;
  }

  return {
    app_metadata: isRecord(payload.app_metadata) ? payload.app_metadata : undefined,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    id,
  };
};

const normalizeSupabaseAccount = (
  response: SupabaseAuthUserResponse,
  previousAccount?: SupabaseAccount
): SupabaseAccount => {
  const id = response.id || previousAccount?.id;
  if (!id) {
    throw new Error('Supabase Auth did not return a user identifier.');
  }

  const providers = new Set<string>();
  for (const identity of response.identities || []) {
    if (typeof identity.provider === 'string') {
      providers.add(identity.provider);
    }
  }
  const appProviders = response.app_metadata?.providers;
  if (Array.isArray(appProviders)) {
    for (const provider of appProviders) {
      if (typeof provider === 'string') {
        providers.add(provider);
      }
    }
  }
  if (typeof response.app_metadata?.provider === 'string') {
    providers.add(response.app_metadata.provider);
  }

  const passwordSetupRequired = response.app_metadata
    ? response.app_metadata.password_setup_required === true
    : previousAccount?.passwordSetupRequired;

  return {
    email: response.email || previousAccount?.email,
    id,
    ...(passwordSetupRequired === undefined ? {} : { passwordSetupRequired }),
    providers: providers.size > 0 ? [...providers] : previousAccount?.providers,
  };
};

export const isPasswordAccount = (account: SupabaseAccount | null): boolean =>
  account?.providers?.includes('email') === true;

const normalizeSession = (
  response: SupabaseAuthResponse,
  previousSession?: SupabaseUserSession
): SupabaseUserSession => {
  if (!response.access_token) {
    throw new Error('Supabase Auth did not return an access token.');
  }

  const accountFromToken = readAccountFromAccessToken(response.access_token);
  const responseAccount = response.user?.id
    ? normalizeSupabaseAccount(response.user, previousSession?.user)
    : previousSession?.user;

  return {
    accessToken: response.access_token,
    authAction:
      response.type === 'invite' || response.type === 'recovery'
        ? response.type
        : previousSession?.authAction,
    expiresAt:
      response.expires_at ||
      (response.expires_in
        ? Math.floor(Date.now() / 1000) + response.expires_in
        : previousSession?.expiresAt),
    refreshToken: response.refresh_token || previousSession?.refreshToken,
    user: accountFromToken
      ? normalizeSupabaseAccount(accountFromToken, responseAccount)
      : responseAccount,
  };
};

const isSessionExpired = (session: SupabaseUserSession): boolean => {
  if (!session.expiresAt) {
    return false;
  }

  return session.expiresAt <= Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SKEW_SECONDS;
};

const stripUnusedSessionFields = (session: SupabaseUserSession): SupabaseUserSession => ({
  accessToken: session.accessToken,
  authAction: session.authAction,
  expiresAt: session.expiresAt,
  refreshToken: session.refreshToken,
  user: session.user
    ? {
        email: session.user.email,
        id: session.user.id,
        passwordSetupRequired: session.user.passwordSetupRequired,
        providers: session.user.providers,
      }
    : undefined,
});

const notifySupabaseSessionChange = (): void => {
  if (typeof globalThis.window !== 'undefined') {
    globalThis.window.dispatchEvent(new Event(SUPABASE_SESSION_CHANGE_EVENT));
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

    const sanitizedSession = stripUnusedSessionFields(parsed);
    const accountFromToken = readAccountFromAccessToken(sanitizedSession.accessToken);
    if (accountFromToken) {
      sanitizedSession.user = normalizeSupabaseAccount(accountFromToken, sanitizedSession.user);
    }
    const sanitizedRawSession = JSON.stringify(sanitizedSession);
    if (sanitizedRawSession !== rawSession) {
      if (storage) {
        storage.setItem(SUPABASE_SESSION_STORAGE_KEY, sanitizedRawSession);
      } else {
        memorySession = sanitizedRawSession;
      }
    }
    return sanitizedSession;
  } catch {
    clearSupabaseSession();
    return null;
  }
};

const hasSameSessionTokens = (
  left: SupabaseUserSession | null,
  right: SupabaseUserSession
): boolean => left?.accessToken === right.accessToken && left.refreshToken === right.refreshToken;

const writeSupabaseSession = (session: SupabaseUserSession): void => {
  const serializedSession = JSON.stringify(stripUnusedSessionFields(session));
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

export const saveSupabaseSession = (session: SupabaseUserSession): void => {
  if (!hasSameSessionTokens(readSupabaseSession(), session)) sessionGeneration += 1;
  writeSupabaseSession(session);
};

export const clearSupabaseSession = (): void => {
  sessionGeneration += 1;
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
  session: SupabaseUserSession,
  generation: number,
  refreshToken: string
): Promise<SupabaseUserSession | null> => {
  const isCurrentSession = (): boolean =>
    generation === sessionGeneration && hasSameSessionTokens(readSupabaseSession(), session);
  const currentSession = (): SupabaseUserSession | null => readSupabaseSession();

  const { anonKey, supabaseUrl } = getSupabaseAuthConfig();
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (error) {
    if (!isCurrentSession()) return currentSession();
    throw error;
  }

  if (!isCurrentSession()) return currentSession();

  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      clearSupabaseSession();
      return null;
    }
    if (response.status === 429 || response.status >= 500) {
      throw new TransientRequestError(SUPABASE_REFRESH_UNAVAILABLE_MESSAGE);
    }
    throw new Error(SUPABASE_REFRESH_UNAVAILABLE_MESSAGE);
  }

  try {
    const payload = (await response.json()) as SupabaseAuthResponse;
    if (!isCurrentSession()) return currentSession();
    const refreshedSession = normalizeSession(payload, session);
    writeSupabaseSession(refreshedSession);
    return refreshedSession;
  } catch {
    if (!isCurrentSession()) return currentSession();
    throw new TransientRequestError(SUPABASE_REFRESH_UNAVAILABLE_MESSAGE);
  }
};

export const refreshSupabaseSession = (): Promise<SupabaseUserSession | null> => {
  const session = readSupabaseSession();
  if (!session?.refreshToken) {
    clearSupabaseSession();
    return Promise.resolve(null);
  }

  if (
    refreshSessionRequest?.generation === sessionGeneration &&
    hasSameSessionTokens(refreshSessionRequest.session, session)
  ) {
    return refreshSessionRequest.promise;
  }

  const generation = sessionGeneration;
  const promise = requestRefreshedSupabaseSession(
    session,
    generation,
    session.refreshToken
  ).finally(() => {
    if (refreshSessionRequest?.promise === promise) refreshSessionRequest = undefined;
  });
  refreshSessionRequest = { generation, promise, session };
  return promise;
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

const logBackendFailureCorrelation = (response: Response): void => {
  if (response.ok) return;
  logBackendFailureCorrelationId(response.headers?.get('x-request-id'));
};

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
    logBackendFailureCorrelation(response);
    return response;
  }

  const refreshedSession = await refreshSupabaseSession();
  if (!refreshedSession) {
    logBackendFailureCorrelation(response);
    return response;
  }

  const retryResponse = await sendRequest(refreshedSession);
  if (retryResponse.status === 401) {
    clearSupabaseSession();
  }
  logBackendFailureCorrelation(retryResponse);
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
  if (typeof globalThis.window === 'undefined') {
    return () => {};
  }

  const handleSessionChange = () => listener(readSupabaseSession());
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === SUPABASE_SESSION_STORAGE_KEY) {
      handleSessionChange();
    }
  };
  globalThis.window.addEventListener(SUPABASE_SESSION_CHANGE_EVENT, handleSessionChange);
  globalThis.window.addEventListener('storage', handleStorageChange);
  return () => {
    globalThis.window.removeEventListener(SUPABASE_SESSION_CHANGE_EVENT, handleSessionChange);
    globalThis.window.removeEventListener('storage', handleStorageChange);
  };
};

const requestCurrentSupabaseAccount = async (
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>
): Promise<SupabaseAccount> => {
  const session = await getValidSupabaseSession();
  if (!session) {
    throw new Error('An authenticated session is required.');
  }

  const { anonKey, supabaseUrl } = getSupabaseAuthConfig();
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session.accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401) {
      clearSupabaseSession();
    }
    throw new Error('Account update failed.');
  }

  const account = normalizeSupabaseAccount(
    (await response.json()) as SupabaseAuthUserResponse,
    session.user
  );
  saveSupabaseSession({
    ...session,
    user: account,
  });
  return account;
};

export const loadSupabaseAccount = (): Promise<SupabaseAccount> =>
  requestCurrentSupabaseAccount('GET');

export const requestSupabaseEmailChange = (email: string): Promise<SupabaseAccount> =>
  requestCurrentSupabaseAccount('PUT', { email: email.trim() });

export const updateSupabasePassword = (password: string): Promise<SupabaseAccount> =>
  requestCurrentSupabaseAccount('PUT', { password });

const readPasswordSetupFailure = async (
  response: Response
): Promise<SupabasePasswordSetupErrorReason | null> => {
  if (response.ok) {
    return null;
  }
  if (response.status === 401) {
    return 'expired';
  }
  if (response.status === 422) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: unknown;
      error_code?: unknown;
    };
    if (body.code === 'weak_password' || body.error_code === 'weak_password') {
      return 'weak-password';
    }
  }
  return 'retryable';
};

const completeSupabaseRecoveryPassword = async (
  session: SupabaseUserSession,
  password: string
): Promise<void> => {
  const { anonKey, supabaseUrl } = getSupabaseAuthConfig();
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
  } catch {
    throw new SupabasePasswordSetupError('retryable');
  }

  const failureReason = await readPasswordSetupFailure(response);
  if (failureReason === 'expired') {
    clearSupabaseSession();
    throw new SupabasePasswordSetupError('expired');
  }
  if (failureReason) {
    throw new SupabasePasswordSetupError(failureReason);
  }

  const account = normalizeSupabaseAccount(
    (await response.json()) as SupabaseAuthUserResponse,
    session.user
  );
  saveSupabaseSession({ ...session, authAction: undefined, user: account });
};

export const completeSupabasePasswordSetup = async (password: string): Promise<void> => {
  const session = await getValidSupabaseSession();
  if (!session) {
    throw new SupabasePasswordSetupError('expired');
  }
  if (!session.user?.passwordSetupRequired) {
    await completeSupabaseRecoveryPassword(session, password);
    return;
  }

  let response: Response;
  try {
    response = await fetchWithSupabaseAuth(`${getBackendUrl()}/api/auth/password-setup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    throw new SupabasePasswordSetupError('retryable');
  }

  const failureReason = await readPasswordSetupFailure(response);
  if (failureReason === 'expired') {
    clearSupabaseSession();
    throw new SupabasePasswordSetupError('expired');
  }
  if (failureReason) {
    throw new SupabasePasswordSetupError(failureReason);
  }

  const email = session.user?.email;
  if (!email) {
    clearSupabaseSession();
    throw new SupabasePasswordSetupError('expired');
  }

  try {
    await signInWithPassword({ email, password });
  } catch {
    throw new SupabasePasswordSetupError('retryable');
  }
};

const ACCOUNT_NEUTRAL_EMAIL_ERROR_CODES = new Set(['otp_disabled', 'user_not_found']);

const isAccountNeutralEmailRejection = async (
  operation: 'magic-link' | 'password-recovery',
  response: Response
): Promise<boolean> => {
  const body = (await response.json().catch(() => ({}))) as {
    code?: unknown;
    error_code?: unknown;
  };
  const providerCode = body.error_code ?? body.code;
  const errorCode = typeof providerCode === 'string' ? providerCode : undefined;
  console.warn(`[Nous][Auth] ${operation} request rejected.`, {
    errorCode,
    status: response.status,
  });
  return Boolean(errorCode && ACCOUNT_NEUTRAL_EMAIL_ERROR_CODES.has(errorCode));
};

export const sendPasswordRecovery = async (email: string): Promise<void> => {
  const { anonKey, supabaseUrl } = getSupabaseAuthConfig();
  const redirectTo = globalThis.window ? `${globalThis.window.location.origin}/` : '';
  const response = await fetch(`${supabaseUrl}/auth/v1/recover`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email.trim(),
      ...(redirectTo ? { redirect_to: redirectTo } : {}),
    }),
  });

  if (!response.ok) {
    if (await isAccountNeutralEmailRejection('password-recovery', response)) {
      return;
    }
    throw new Error('Password recovery failed.');
  }
};

export const signOutSupabase = async (): Promise<void> => {
  const session = readSupabaseSession();
  if (!session) {
    clearSupabaseSession();
    return;
  }

  const { anonKey, supabaseUrl } = getSupabaseAuthConfig();
  const response = await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session.accessToken}`,
    },
  });
  if (!response.ok && response.status !== 401) {
    throw new Error('Sign out failed.');
  }

  clearSupabaseSession();
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
  if (globalThis.window?.location.pathname === '/landing') {
    globalThis.window.history.replaceState(null, document.title, '/');
  }
  return session;
};

export const sendMagicLink = async (email: string): Promise<void> => {
  const { anonKey, supabaseUrl } = getSupabaseAuthConfig();
  const emailRedirectTo = globalThis.window ? `${globalThis.window.location.origin}/` : '';
  const response = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      create_user: false,
      email: email.trim(),
      type: 'magiclink',
      ...(emailRedirectTo ? { redirect_to: emailRedirectTo } : {}),
    }),
  });

  if (!response.ok) {
    if (await isAccountNeutralEmailRejection('magic-link', response)) {
      return;
    }
    throw new Error('Invio magic link non riuscito.');
  }
};

export const readSupabaseAuthCallbackFromUrl = (): SupabaseAuthCallbackResult => {
  if (globalThis.window === undefined) {
    return { status: 'none', session: null };
  }

  const params = new URLSearchParams(globalThis.window.location.hash.replace(/^#/, ''));
  if (params.has('error') || params.has('error_code')) {
    return { status: 'error', session: null };
  }

  const accessToken = params.get('access_token');
  if (!accessToken) {
    return { status: 'none', session: readSupabaseSession() };
  }

  const callbackType = params.get('type');
  const expiresAt = Number.parseInt(params.get('expires_at') || '', 10);
  const expiresIn = Number.parseInt(params.get('expires_in') || '', 10);

  const session: SupabaseUserSession = {
    accessToken,
    authAction: callbackType === 'invite' || callbackType === 'recovery' ? callbackType : undefined,
    refreshToken: params.get('refresh_token') || undefined,
    expiresAt: expiresAt || (expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : undefined),
    user: (() => {
      const account = readAccountFromAccessToken(accessToken);
      return account ? normalizeSupabaseAccount(account) : undefined;
    })(),
  };
  return { status: 'success', session };
};

export const consumeSupabaseAuthCallbackFromUrl = (): SupabaseAuthCallbackResult => {
  const callback = readSupabaseAuthCallbackFromUrl();
  if (callback.status === 'none' || globalThis.window === undefined) {
    return callback;
  }

  if (callback.status === 'error') {
    clearSupabaseSession();
  } else {
    saveSupabaseSession(callback.session);
  }
  const callbackPath =
    globalThis.window.location.pathname === '/landing' ? '/' : globalThis.window.location.pathname;
  globalThis.window.history.replaceState(
    null,
    document.title,
    `${callbackPath}${globalThis.window.location.search}`
  );
  return callback;
};
