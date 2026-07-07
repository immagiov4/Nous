// Bootstraps the local files needed for Sonar analysis runs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SONAR_HOST_URL = 'http://localhost:9000';
const LOCAL_SETTINGS_PATH = path.resolve('sonar.local.properties');
const DEFAULT_ADMIN_LOGIN = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin';
const LOCAL_TOKEN_NAME = 'lumina-reader-local';
const JSON_CONTENT_TYPE = 'application/json';

type LocalSettings = Record<string, string>;

type SonarAuth = {
  login: string;
  password: string;
};

type ValidateResponse = {
  valid: boolean;
};

type TokenSearchResponse = {
  userTokens: Array<{
    name: string;
  }>;
};

type TokenGenerateResponse = {
  token: string;
};

const parsePropertiesFile = (filePath: string): LocalSettings => {
  if (!existsSync(filePath)) {
    return {};
  }

  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .reduce<LocalSettings>((settings, line) => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) {
        return settings;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      settings[key] = value;
      return settings;
    }, {});
};

const writePropertiesFile = (filePath: string, settings: LocalSettings) => {
  const lines = Object.entries(settings).map(([key, value]) => `${key}=${value}`);
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
};

const getBasicAuthorizationHeader = ({ login, password }: SonarAuth) => {
  const credentials = [login, password].join(':');
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
};

const requestSonar = async (endpoint: string, init: RequestInit) => {
  try {
    return await fetch(`${SONAR_HOST_URL}${endpoint}`, init);
  } catch (error) {
    throw new Error(
      `Unable to reach SonarQube at ${SONAR_HOST_URL} for ${endpoint}. Start the local Sonar stack and retry.`,
      { cause: error }
    );
  }
};

const validateToken = async (token: string) => {
  const response = await requestSonar('/api/authentication/validate', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return false;
  }

  const body = (await response.json()) as ValidateResponse;
  return body.valid;
};

const validateCredentials = async (auth: SonarAuth) => {
  const response = await requestSonar('/api/authentication/validate', {
    headers: {
      Authorization: getBasicAuthorizationHeader(auth),
    },
  });

  if (!response.ok) {
    return false;
  }

  const body = (await response.json()) as ValidateResponse;
  return body.valid;
};

const postForm = async <TResponse>(
  endpoint: string,
  auth: SonarAuth,
  params: Record<string, string>
): Promise<TResponse> => {
  const body = new URLSearchParams(params);
  const response = await requestSonar(endpoint, {
    method: 'POST',
    headers: {
      Authorization: getBasicAuthorizationHeader(auth),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Sonar request failed for ${endpoint}: ${response.status} ${response.statusText}`
    );
  }

  if (response.headers.get('content-type')?.includes(JSON_CONTENT_TYPE)) {
    return (await response.json()) as TResponse;
  }

  return {} as TResponse;
};

const getJson = async <TResponse>(endpoint: string, auth: SonarAuth): Promise<TResponse> => {
  const response = await requestSonar(endpoint, {
    headers: {
      Authorization: getBasicAuthorizationHeader(auth),
    },
  });

  if (!response.ok) {
    throw new Error(
      `Sonar request failed for ${endpoint}: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as TResponse;
};

const resolveAdminAuth = async (settings: LocalSettings) => {
  const storedLogin = settings['sonar.admin.login']?.trim();
  const storedPassword = settings['sonar.admin.password']?.trim();

  if (storedLogin && storedPassword) {
    const storedAuth = { login: storedLogin, password: storedPassword };
    if (await validateCredentials(storedAuth)) {
      return storedAuth;
    }
  }

  const defaultAuth = {
    login: DEFAULT_ADMIN_LOGIN,
    password: DEFAULT_ADMIN_PASSWORD,
  };
  if (await validateCredentials(defaultAuth)) {
    return defaultAuth;
  }

  throw new Error(
    'Unable to authenticate to the local SonarQube admin account. If the password was changed outside this script, update sonar.local.properties and retry.'
  );
};

const ensureToken = async (auth: SonarAuth) => {
  const existingTokens = await getJson<TokenSearchResponse>('/api/user_tokens/search', auth);
  if (existingTokens.userTokens.some(token => token.name === LOCAL_TOKEN_NAME)) {
    await postForm('/api/user_tokens/revoke', auth, {
      name: LOCAL_TOKEN_NAME,
    });
  }

  const generatedToken = await postForm<TokenGenerateResponse>('/api/user_tokens/generate', auth, {
    name: LOCAL_TOKEN_NAME,
  });
  return generatedToken.token;
};

const main = async () => {
  const settings = parsePropertiesFile(LOCAL_SETTINGS_PATH);
  const currentToken = settings['sonar.token']?.trim();
  if (currentToken && (await validateToken(currentToken))) {
    process.stdout.write(`Sonar local bootstrap already ready via ${LOCAL_SETTINGS_PATH}.\n`);
    return;
  }

  const authenticatedAdmin = await resolveAdminAuth(settings);
  const token = await ensureToken(authenticatedAdmin);

  writePropertiesFile(LOCAL_SETTINGS_PATH, {
    'sonar.host.url': SONAR_HOST_URL,
    'sonar.token': token,
    'sonar.token.name': LOCAL_TOKEN_NAME,
    'sonar.admin.login': authenticatedAdmin.login,
    'sonar.admin.password': authenticatedAdmin.password,
  });

  process.stdout.write(
    `Sonar local bootstrap completed. Saved credentials to ${LOCAL_SETTINGS_PATH}.\n`
  );
};

await main();
