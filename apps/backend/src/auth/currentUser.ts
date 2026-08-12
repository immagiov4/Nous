// Resolves the current backend user from either local dev bypass or Supabase JWT auth.
import { createHmac, timingSafeEqual, webcrypto } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import {
  type AiProvider,
  isAiProvider,
  type ModelProviderOverrides,
  readModelProviderOverrides,
} from '../config/modelConfig.js';

const DEFAULT_LOCAL_USER_ID = 'local-user';
export const LOCAL_AUTH_MODE = 'local-bypass' as const;
export const SUPABASE_AUTH_MODE = 'supabase' as const;
const AUTH_REQUIRED_MESSAGE = 'Accesso richiesto.';
const INVALID_AUTH_MESSAGE = 'Sessione non valida. Accedi di nuovo.';
const PASSWORD_SETUP_REQUIRED_MESSAGE = 'Completa la configurazione della password.';
const JWKS_CACHE_MS = 5 * 60 * 1000;
const SUPABASE_ACCESS_TOKEN_AUDIENCE = 'authenticated';

type AuthMode = typeof LOCAL_AUTH_MODE | typeof SUPABASE_AUTH_MODE;

export interface CurrentUser {
  aiProvider?: AiProvider;
  aiProviderOverrides?: ModelProviderOverrides;
  email?: string;
  id: string;
  passwordSetupRequired: boolean;
  role?: string;
}

interface RequestWithCurrentUser extends Request {
  currentUser: CurrentUser;
}

interface CachedJwks {
  expiresAt: number;
  keys: Record<string, unknown>[];
  url: string;
}

let cachedJwks: CachedJwks | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const getAuthMode = (): AuthMode => {
  const configuredMode = process.env.AUTH_MODE?.trim();
  if (configuredMode === LOCAL_AUTH_MODE || configuredMode === SUPABASE_AUTH_MODE) {
    return configuredMode;
  }

  return process.env.LOCAL_AUTH_BYPASS === 'true' || process.env.NODE_ENV === 'test'
    ? LOCAL_AUTH_MODE
    : SUPABASE_AUTH_MODE;
};

const isLocalAuthBypassEnabled = (): boolean =>
  getAuthMode() === LOCAL_AUTH_MODE &&
  (process.env.NODE_ENV === 'test' ||
    (process.env.LOCAL_AUTH_BYPASS === 'true' && process.env.LOCAL_DEV_PROFILE === 'true'));

const extractBearerToken = (req: Request): string | null => {
  const authorization = req.get('authorization')?.trim();
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
};

const safeBase64UrlJsonParse = (value: string): Record<string, unknown> => {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const parsed = JSON.parse(decoded) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('JWT payload is not an object.');
  }

  return parsed;
};

const signaturesMatch = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const verifyHs256Signature = ({
  encodedHeader,
  encodedPayload,
  jwtSecret,
  signature,
}: {
  encodedHeader: string;
  encodedPayload: string;
  jwtSecret: string;
  signature: string;
}): void => {
  const expectedSignature = createHmac('sha256', jwtSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  if (!signaturesMatch(signature, expectedSignature)) {
    throw new Error('Invalid JWT signature.');
  }
};

const getSupabaseJwksUrl = (): string => {
  const explicitJwksUrl = process.env.SUPABASE_JWKS_URL?.trim();
  if (explicitJwksUrl) {
    return explicitJwksUrl;
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL or SUPABASE_JWKS_URL is required for asymmetric JWT auth.');
  }

  return `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
};

const loadSupabaseJwks = async (forceRefresh = false): Promise<Record<string, unknown>[]> => {
  const url = getSupabaseJwksUrl();
  const now = Date.now();
  if (!forceRefresh && cachedJwks?.url === url && cachedJwks.expiresAt > now) {
    return cachedJwks.keys;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load Supabase JWKS: ${response.status}`);
  }

  const body = (await response.json()) as unknown;
  const keys = isRecord(body) && Array.isArray(body.keys) ? body.keys.filter(isRecord) : [];
  if (keys.length === 0) {
    throw new Error('Supabase JWKS did not include signing keys.');
  }

  cachedJwks = {
    expiresAt: now + JWKS_CACHE_MS,
    keys,
    url,
  };
  return keys;
};

const verifyEs256Signature = async ({
  encodedHeader,
  encodedPayload,
  header,
  signature,
}: {
  encodedHeader: string;
  encodedPayload: string;
  header: Record<string, unknown>;
  signature: string;
}): Promise<void> => {
  const keyId = readString(header.kid);
  if (!keyId) {
    throw new Error('JWT key id is required.');
  }

  const cachedKeys = await loadSupabaseJwks();
  const jwk =
    cachedKeys.find(key => key.kid === keyId) ||
    (await loadSupabaseJwks(true)).find(key => key.kid === keyId);
  if (!jwk) {
    throw new Error('Supabase JWKS key not found.');
  }

  const cryptoKey = await webcrypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const isValid = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    Buffer.from(signature, 'base64url'),
    Buffer.from(`${encodedHeader}.${encodedPayload}`)
  );

  if (!isValid) {
    throw new Error('Invalid JWT signature.');
  }
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const readRole = (payload: Record<string, unknown>): string | undefined => {
  const appMetadata = isRecord(payload.app_metadata) ? payload.app_metadata : undefined;
  return readString(appMetadata?.role) || readString(appMetadata?.user_role);
};

const readAiProvider = (payload: Record<string, unknown>): AiProvider | undefined => {
  const appMetadata = isRecord(payload.app_metadata) ? payload.app_metadata : undefined;
  return isAiProvider(appMetadata?.ai_provider) ? appMetadata.ai_provider : undefined;
};

const readAiProviderOverrides = (
  payload: Record<string, unknown>
): ModelProviderOverrides | undefined => {
  const appMetadata = isRecord(payload.app_metadata) ? payload.app_metadata : undefined;
  const overrides = readModelProviderOverrides(appMetadata?.ai_provider_overrides);
  return Object.keys(overrides).length > 0 ? overrides : undefined;
};

const readPasswordSetupRequired = (payload: Record<string, unknown>): boolean => {
  const appMetadata = isRecord(payload.app_metadata) ? payload.app_metadata : undefined;
  return appMetadata?.password_setup_required === true;
};

const getSupabaseJwtIssuer = (): string => {
  const explicitIssuer = process.env.SUPABASE_JWT_ISSUER?.trim();
  if (explicitIssuer) {
    return explicitIssuer.replace(/\/$/, '');
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL or SUPABASE_JWT_ISSUER is required for JWT validation.');
  }
  return `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
};

const hasExpectedAudience = (audience: unknown): boolean => {
  return (
    audience === SUPABASE_ACCESS_TOKEN_AUDIENCE ||
    (Array.isArray(audience) && audience.some(value => value === SUPABASE_ACCESS_TOKEN_AUDIENCE))
  );
};

const assertSupabaseAccessTokenClaims = (payload: Record<string, unknown>): void => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new Error('JWT expiration is required.');
  }
  if (payload.exp <= nowSeconds) {
    throw new Error('JWT expired.');
  }
  if (payload.iss !== getSupabaseJwtIssuer()) {
    throw new Error('Invalid JWT issuer.');
  }
  if (!hasExpectedAudience(payload.aud)) {
    throw new Error('Invalid JWT audience.');
  }
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)) {
      throw new Error('Invalid JWT not-before claim.');
    }
    if (payload.nbf > nowSeconds) {
      throw new Error('JWT is not active yet.');
    }
  }
};

const resolveSupabaseJwtUser = async (token: string): Promise<CurrentUser> => {
  const [encodedHeader, encodedPayload, signature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !signature) {
    throw new Error('Malformed JWT.');
  }

  const header = safeBase64UrlJsonParse(encodedHeader);
  if (header.alg === 'HS256') {
    const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
    if (!jwtSecret) {
      throw new Error('SUPABASE_JWT_SECRET is required for HS256 JWT auth.');
    }

    verifyHs256Signature({
      encodedHeader,
      encodedPayload,
      jwtSecret,
      signature,
    });
  } else if (header.alg === 'ES256') {
    await verifyEs256Signature({
      encodedHeader,
      encodedPayload,
      header,
      signature,
    });
  } else {
    throw new Error('Unsupported JWT algorithm.');
  }

  const payload = safeBase64UrlJsonParse(encodedPayload);
  assertSupabaseAccessTokenClaims(payload);

  const userId = readString(payload.sub);
  if (!userId) {
    throw new Error('JWT subject is required.');
  }

  return {
    aiProvider: readAiProvider(payload),
    aiProviderOverrides: readAiProviderOverrides(payload),
    id: userId,
    email: readString(payload.email),
    passwordSetupRequired: readPasswordSetupRequired(payload),
    role: readRole(payload),
  };
};

const resolveAuthenticatedUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
  allowPasswordSetup: boolean
): Promise<void> => {
  if (isLocalAuthBypassEnabled()) {
    (req as RequestWithCurrentUser).currentUser = {
      id: process.env.LOCAL_USER_ID?.trim() || DEFAULT_LOCAL_USER_ID,
      passwordSetupRequired: false,
    };
    next();
    return;
  }

  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({
      success: false,
      error: AUTH_REQUIRED_MESSAGE,
    });
    return;
  }

  try {
    const currentUser = await resolveSupabaseJwtUser(token);
    if (currentUser.passwordSetupRequired && !allowPasswordSetup) {
      res.status(403).json({
        success: false,
        code: 'password_setup_required',
        error: PASSWORD_SETUP_REQUIRED_MESSAGE,
      });
      return;
    }
    (req as RequestWithCurrentUser).currentUser = currentUser;
    next();
  } catch (error) {
    console.warn('[Auth] Supabase JWT rejected:', error);
    res.status(401).json({
      success: false,
      error: INVALID_AUTH_MESSAGE,
    });
  }
};

export const resolveCurrentUser = (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => resolveAuthenticatedUser(req, res, next, false);

export const resolveCurrentUserForPasswordSetup = (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => resolveAuthenticatedUser(req, res, next, true);

export const getCurrentUser = (req: Request): CurrentUser => {
  const currentUser = (req as RequestWithCurrentUser).currentUser;
  if (!currentUser) {
    throw new Error('Current user was not resolved before accessing project storage.');
  }

  return currentUser;
};
