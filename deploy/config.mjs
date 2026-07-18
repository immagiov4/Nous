import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEPLOYMENT_PROFILES = new Set(['managed', 'self-hosted']);
const REQUIRED_PUBLIC_KEYS = [
  'NOUS_PUBLIC_URL',
  'NOUS_BACKEND_PUBLIC_URL',
  'NOUS_SUPABASE_PUBLIC_URL',
];
const REQUIRED_RUNTIME_KEYS = [
  'NOUS_SUPABASE_ANON_KEY',
  'SUPABASE_URL',
  'DATABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CORS_ALLOWED_ORIGINS',
  'DECODO_SCRAPING_API_KEY',
];

const parseEnv = text =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      })
  );

const isPlaceholder = value =>
  !value ||
  /^(replace_|your_|sk-proj-x)/i.test(value) ||
  /(?:example\.com|project\.supabase\.co|db\.example\.com)/i.test(value);

const validateUrl = (key, value, errors) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`${key} must use http or https.`);
    }
  } catch {
    errors.push(`${key} must be an absolute URL.`);
  }
};

export const validateDeploymentConfig = (env, { bootstrap = false } = {}) => {
  const errors = [];
  const profile = env.SUPABASE_DEPLOYMENT;
  if (!DEPLOYMENT_PROFILES.has(profile)) {
    errors.push('SUPABASE_DEPLOYMENT must be managed or self-hosted.');
  }
  if (env.CODEX_APP_SERVER_ENABLED && !['true', 'false'].includes(env.CODEX_APP_SERVER_ENABLED)) {
    errors.push('CODEX_APP_SERVER_ENABLED must be true or false.');
  }
  for (const key of REQUIRED_PUBLIC_KEYS) {
    if (isPlaceholder(env[key])) {
      errors.push(`${key} is missing or still contains an example value.`);
    } else {
      validateUrl(key, env[key], errors);
    }
  }

  if (isPlaceholder(env.OPENROUTER_API_KEY)) {
    errors.push('OPENROUTER_API_KEY is missing or still contains an example value.');
  }
  if (
    env.GITHUB_FEEDBACK_REPOSITORY &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_FEEDBACK_REPOSITORY)
  ) {
    errors.push('GITHUB_FEEDBACK_REPOSITORY must use the owner/repository format.');
  }
  if (Boolean(env.GITHUB_FEEDBACK_REPOSITORY) !== Boolean(env.GITHUB_FEEDBACK_TOKEN)) {
    errors.push(
      'GITHUB_FEEDBACK_REPOSITORY and GITHUB_FEEDBACK_TOKEN must both be set to enable GitHub feedback.'
    );
  }
  if (
    env.GITHUB_FEEDBACK_REPOSITORY &&
    env.GITHUB_FEEDBACK_TOKEN &&
    (isPlaceholder(env.GITHUB_FEEDBACK_REPOSITORY) || isPlaceholder(env.GITHUB_FEEDBACK_TOKEN))
  ) {
    errors.push('GitHub feedback settings must not contain placeholder values.');
  }

  if (!bootstrap || profile === 'managed') {
    for (const key of REQUIRED_RUNTIME_KEYS) {
      if (isPlaceholder(env[key])) {
        errors.push(`${key} is missing or still contains an example value.`);
      }
    }
    if (!env.SUPABASE_JWT_SECRET && !env.SUPABASE_JWKS_URL) {
      errors.push('Set SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL.');
    }
    if (env.SUPABASE_URL && !isPlaceholder(env.SUPABASE_URL)) {
      validateUrl('SUPABASE_URL', env.SUPABASE_URL, errors);
    }
    if (env.DATABASE_URL && !/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL)) {
      errors.push('DATABASE_URL must be a PostgreSQL connection URL.');
    }
    const allowedOrigins = (env.CORS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim());
    if (env.NOUS_PUBLIC_URL && !allowedOrigins.includes(env.NOUS_PUBLIC_URL.replace(/\/$/, ''))) {
      errors.push('CORS_ALLOWED_ORIGINS must include NOUS_PUBLIC_URL.');
    }
  }

  if (profile === 'managed' && env.SUPABASE_URL && env.NOUS_SUPABASE_PUBLIC_URL) {
    try {
      if (new URL(env.SUPABASE_URL).origin !== new URL(env.NOUS_SUPABASE_PUBLIC_URL).origin) {
        errors.push(
          'Managed SUPABASE_URL and NOUS_SUPABASE_PUBLIC_URL must use the same project origin.'
        );
      }
    } catch {
      // The URL-specific errors above are more useful.
    }
  }

  for (const key of ['NOUS_FRONTEND_PORT', 'NOUS_BACKEND_PORT']) {
    const value = env[key];
    if (value && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535)) {
      errors.push(`${key} must be a valid TCP port.`);
    }
  }

  return errors;
};

const getPublishedPort = value => {
  const port = value?.split(':').at(-1) || '8000';
  if (!/^\d+$/.test(port)) {
    throw new Error('KONG_HTTP_PORT in the Supabase bundle is invalid.');
  }
  return port;
};

export const buildSelfHostedUpdates = (appEnv, supabaseEnv) => {
  const publishableKey = supabaseEnv.SUPABASE_PUBLISHABLE_KEY || supabaseEnv.ANON_KEY;
  const serviceKey = supabaseEnv.SUPABASE_SECRET_KEY || supabaseEnv.SERVICE_ROLE_KEY;
  for (const [key, value] of Object.entries({
    JWT_SECRET: supabaseEnv.JWT_SECRET,
    POSTGRES_PASSWORD: supabaseEnv.POSTGRES_PASSWORD,
    publishableKey,
    serviceKey,
  })) {
    if (isPlaceholder(value)) {
      throw new Error(`The official Supabase key generator did not configure ${key}.`);
    }
  }

  const publicAppUrl = appEnv.NOUS_PUBLIC_URL.replace(/\/$/, '');
  const publicSupabaseUrl = appEnv.NOUS_SUPABASE_PUBLIC_URL.replace(/\/$/, '');
  getPublishedPort(supabaseEnv.KONG_HTTP_PORT);
  const databasePort = supabaseEnv.POSTGRES_PORT || '5432';
  const encodedPassword = encodeURIComponent(supabaseEnv.POSTGRES_PASSWORD);

  return {
    app: {
      CORS_ALLOWED_ORIGINS: publicAppUrl,
      DATABASE_URL: `postgresql://postgres:${encodedPassword}@db:${databasePort}/postgres?sslmode=disable`,
      NOUS_SUPABASE_ANON_KEY: publishableKey,
      SUPABASE_JWKS_URL: 'http://kong:8000/auth/v1/.well-known/jwks.json',
      SUPABASE_JWT_SECRET: supabaseEnv.JWT_SECRET,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      SUPABASE_URL: 'http://kong:8000',
    },
    supabase: {
      ADDITIONAL_REDIRECT_URLS: `${publicAppUrl}/**`,
      API_EXTERNAL_URL: `${publicSupabaseUrl}/auth/v1`,
      DISABLE_SIGNUP: 'true',
      POOLER_TENANT_ID: 'nous-reader',
      SITE_URL: publicAppUrl,
      SUPABASE_PUBLIC_URL: publicSupabaseUrl,
    },
  };
};

const updateEnv = (text, updates) => {
  const pending = new Map(Object.entries(updates));
  const lines = text.split(/\r?\n/).map(line => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match || !pending.has(match[1])) {
      return line;
    }
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  for (const [key, value] of pending) {
    lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
};

const main = () => {
  const [command, appEnvPath, supabaseEnvPath] = process.argv.slice(2);
  if (!command || !appEnvPath) {
    throw new Error(
      'Usage: node deploy/config.mjs check|check-bootstrap|configure <app-env> [supabase-env]'
    );
  }

  const appText = readFileSync(appEnvPath, 'utf8');
  const appEnv = parseEnv(appText);
  if (command === 'check' || command === 'check-bootstrap') {
    const errors = validateDeploymentConfig(appEnv, { bootstrap: command === 'check-bootstrap' });
    if (errors.length > 0) {
      throw new Error(`Deployment configuration is invalid:\n- ${errors.join('\n- ')}`);
    }
    process.stdout.write(`Configuration valid for ${appEnv.SUPABASE_DEPLOYMENT}.\n`);
    return;
  }

  if (command !== 'configure' || !supabaseEnvPath) {
    throw new Error('configure requires the official Supabase .env path.');
  }
  const supabaseText = readFileSync(supabaseEnvPath, 'utf8');
  const updates = buildSelfHostedUpdates(appEnv, parseEnv(supabaseText));
  writeFileSync(appEnvPath, updateEnv(appText, updates.app));
  writeFileSync(supabaseEnvPath, updateEnv(supabaseText, updates.supabase));
  process.stdout.write(
    'Self-hosted Supabase configuration synchronized without printing secrets.\n'
  );
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
