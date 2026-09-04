import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';

import { buildSelfHostedUpdates, validateDeploymentConfig } from '../../../../deploy/config.mjs';
import { checkHealthEndpoints } from '../../../../deploy/health-smoke.mjs';
import { bootstrapAdmin } from '../../../../scripts/bootstrap-admin.ts';
import {
  buildRuntimeConfigScript,
  getFrontendApiMisrouteResponse,
  resolveStaticFilePath,
} from '../../../../scripts/serve-production-frontend.ts';

const DEPLOYMENT_ENV = {
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'deployment-secret',
  NOUS_BACKEND_PUBLIC_URL: 'https://api.example.com/',
  NOUS_SUPABASE_ANON_KEY: 'publishable-key',
  NOUS_SUPABASE_PUBLIC_URL: 'https://auth.example.com/',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_URL: 'https://auth-internal.example.com/',
};

const SELF_HOSTED_OVERRIDE = parse(
  readFileSync(resolve('deploy/supabase.override.yml'), 'utf8').replaceAll('!override', '')
) as {
  services: Record<string, Record<string, unknown>>;
};
const APP_COMPOSE = parse(readFileSync(resolve('compose.yml'), 'utf8')) as {
  services: Record<string, { environment?: Record<string, string>; volumes?: string[] }>;
  volumes?: Record<string, unknown>;
};

describe('production deployment boundaries', () => {
  test('validates the deployment profile and managed project origin', () => {
    const baseConfig = {
      SUPABASE_DEPLOYMENT: 'managed',
      NOUS_PUBLIC_URL: 'https://reader.acme.test',
      NOUS_BACKEND_PUBLIC_URL: 'https://api.acme.test',
      NOUS_SUPABASE_PUBLIC_URL: 'https://alpha-ref.supabase.co',
      NOUS_SUPABASE_ANON_KEY: 'publishable-key',
      SUPABASE_URL: 'https://different.supabase.co',
      DATABASE_URL: 'postgresql://postgres:secret@aws-0-eu.pooler.supabase.com:5432/postgres',
      GITHUB_FEEDBACK_REPOSITORY: 'example/nous-reader',
      GITHUB_FEEDBACK_TOKEN: 'github-test-token',
      OPENROUTER_API_KEY: 'openrouter-test-key',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_JWKS_URL: 'https://alpha-ref.supabase.co/auth/v1/.well-known/jwks.json',
      CORS_ALLOWED_ORIGINS: 'https://reader.acme.test',
      DECODO_SCRAPING_API_KEY: 'decodo-test-key',
    };

    expect(validateDeploymentConfig({ ...baseConfig, SUPABASE_DEPLOYMENT: 'hybrid' })).toContain(
      'SUPABASE_DEPLOYMENT must be managed or self-hosted.'
    );
    expect(validateDeploymentConfig(baseConfig)).toContain(
      'Managed SUPABASE_URL and NOUS_SUPABASE_PUBLIC_URL must use the same project origin.'
    );
    expect(validateDeploymentConfig({ ...baseConfig, SUPABASE_JWT_ISSUER: 'not-a-url' })).toContain(
      'SUPABASE_JWT_ISSUER must be an absolute URL.'
    );
    expect(
      validateDeploymentConfig({ ...baseConfig, SUPABASE_URL: baseConfig.NOUS_SUPABASE_PUBLIC_URL })
    ).toEqual([]);
    const githubOptionalConfig = {
      ...baseConfig,
      SUPABASE_URL: baseConfig.NOUS_SUPABASE_PUBLIC_URL,
      GITHUB_FEEDBACK_REPOSITORY: '',
      GITHUB_FEEDBACK_TOKEN: '',
    };
    expect(validateDeploymentConfig(githubOptionalConfig)).toEqual([]);
    expect(
      validateDeploymentConfig({
        ...githubOptionalConfig,
        GITHUB_FEEDBACK_REPOSITORY: 'example/nous-reader',
      })
    ).toContain(
      'GITHUB_FEEDBACK_REPOSITORY and GITHUB_FEEDBACK_TOKEN must both be set to enable GitHub feedback.'
    );
    expect(
      validateDeploymentConfig({
        ...githubOptionalConfig,
        GITHUB_FEEDBACK_REPOSITORY: 'example/nous-reader',
        GITHUB_FEEDBACK_TOKEN: 'replace_with_fine_grained_github_token',
      })
    ).toContain('GitHub feedback settings must not contain placeholder values.');
  });

  test('derives self-hosted application credentials from the official generated env', () => {
    const updates = buildSelfHostedUpdates(
      {
        NOUS_PUBLIC_URL: 'https://reader.acme.test/',
        NOUS_SUPABASE_PUBLIC_URL: 'https://auth.acme.test/',
      },
      {
        JWT_SECRET: 'generated-jwt-secret',
        KONG_HTTP_PORT: '127.0.0.1:8000',
        POSTGRES_PASSWORD: 'generated-postgres-password',
        POSTGRES_PORT: '5432',
        SUPABASE_PUBLISHABLE_KEY: 'generated-publishable-key',
        SUPABASE_SECRET_KEY: 'generated-service-key',
      }
    );

    expect(updates.app).toEqual({
      CORS_ALLOWED_ORIGINS: 'https://reader.acme.test',
      DATABASE_URL:
        'postgresql://postgres:generated-postgres-password@db:5432/postgres?sslmode=disable',
      NOUS_SUPABASE_ANON_KEY: 'generated-publishable-key',
      SUPABASE_JWKS_URL: 'http://kong:8000/auth/v1/.well-known/jwks.json',
      SUPABASE_JWT_ISSUER: 'https://auth.acme.test/auth/v1',
      SUPABASE_JWT_SECRET: 'generated-jwt-secret',
      SUPABASE_SERVICE_ROLE_KEY: 'generated-service-key',
      SUPABASE_URL: 'http://kong:8000',
    });
    expect(updates.supabase).toMatchObject({
      API_EXTERNAL_URL: 'https://auth.acme.test/auth/v1',
      DISABLE_SIGNUP: 'true',
      SITE_URL: 'https://reader.acme.test',
      SUPABASE_PUBLIC_URL: 'https://auth.acme.test',
    });
  });

  test('serves branded Auth email templates inside the self-hosted Supabase network', () => {
    const auth = SELF_HOSTED_OVERRIDE.services.auth as {
      depends_on: Record<string, { condition: string }>;
      environment: Record<string, string>;
    };
    const templateServer = SELF_HOSTED_OVERRIDE.services['email-templates'] as {
      healthcheck: { test: string[] };
      volumes: string[];
    };

    expect(auth.depends_on['email-templates']).toEqual({ condition: 'service_healthy' });
    expect(auth.environment).toMatchObject({
      GOTRUE_MAILER_SUBJECTS_CONFIRMATION: 'Conferma il tuo account Nous',
      GOTRUE_MAILER_SUBJECTS_INVITE: 'Il tuo invito a Nous',
      GOTRUE_MAILER_SUBJECTS_MAGIC_LINK: 'Accedi a Nous',
      GOTRUE_MAILER_SUBJECTS_RECOVERY: 'Reimposta la password Nous',
      GOTRUE_MAILER_TEMPLATE_RELOADING_ENABLED: 'true',
      GOTRUE_MAILER_TEMPLATES_CONFIRMATION: 'http://email-templates/confirmation.html',
      GOTRUE_MAILER_TEMPLATES_INVITE: 'http://email-templates/invite.html',
      GOTRUE_MAILER_TEMPLATES_MAGIC_LINK: 'http://email-templates/magic-link.html',
      GOTRUE_MAILER_TEMPLATES_RECOVERY: 'http://email-templates/recovery.html',
    });
    expect(templateServer.volumes).toContain('../../supabase/templates:/usr/share/nginx/html:ro');
    expect(templateServer.healthcheck.test).toContain('http://127.0.0.1/magic-link.html');
  });

  test('passes private integration credentials only to the backend', () => {
    expect(APP_COMPOSE.services.backend?.environment).toMatchObject({
      DECODO_SCRAPING_API_KEY: `\${DECODO_SCRAPING_API_KEY:-}`,
      GITHUB_FEEDBACK_REPOSITORY: `\${GITHUB_FEEDBACK_REPOSITORY:-}`,
      GITHUB_FEEDBACK_TOKEN: `\${GITHUB_FEEDBACK_TOKEN:-}`,
    });
    expect(APP_COMPOSE.services.frontend?.environment).not.toHaveProperty(
      'DECODO_SCRAPING_API_KEY'
    );
    expect(APP_COMPOSE.services.frontend?.environment).not.toHaveProperty('GITHUB_FEEDBACK_TOKEN');
  });

  test('keeps resumable library exports on a durable backend volume', () => {
    expect(APP_COMPOSE.services.backend?.environment).toMatchObject({
      LIBRARY_EXPORT_ROOT: '/var/lib/nous/library-exports',
    });
    expect(APP_COMPOSE.services.backend?.volumes).toContain(
      'library-exports:/var/lib/nous/library-exports'
    );
    expect(APP_COMPOSE.volumes).toHaveProperty('library-exports');
  });

  test('fails the stack smoke contract on the first unhealthy dependency', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(
      checkHealthEndpoints(
        {
          NOUS_SMOKE_FRONTEND_URL: 'http://frontend/health',
          NOUS_SMOKE_BACKEND_URL: 'http://backend/health',
          NOUS_SMOKE_SUPABASE_AUTH_URL: 'http://supabase/auth/v1/health',
        },
        request
      )
    ).rejects.toThrow('backend health check returned HTTP 503.');
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('authenticates only the Supabase Auth smoke request', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await checkHealthEndpoints(
      {
        NOUS_SMOKE_FRONTEND_URL: 'http://frontend/health',
        NOUS_SMOKE_BACKEND_URL: 'http://backend/health',
        NOUS_SMOKE_SUPABASE_AUTH_URL: 'http://supabase/auth/v1/health',
        NOUS_SUPABASE_ANON_KEY: 'publishable-key',
      },
      request
    );

    expect(request).toHaveBeenNthCalledWith(
      1,
      'http://frontend/health',
      expect.objectContaining({ headers: undefined })
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'http://supabase/auth/v1/health',
      expect.objectContaining({
        headers: {
          apikey: 'publishable-key',
          Authorization: 'Bearer publishable-key',
        },
      })
    );
  });

  test('serializes runtime browser configuration without allowing script injection', () => {
    const context = { globalThis: {} as Record<string, unknown> };
    const script = buildRuntimeConfigScript({
      ...DEPLOYMENT_ENV,
      NOUS_SUPABASE_ANON_KEY: '"; globalThis.injected = true; //',
    });

    vm.runInNewContext(script, context);

    expect(context.globalThis.injected).toBeUndefined();
    expect(context.globalThis.__NOUS_RUNTIME_CONFIG__).toMatchObject({
      backendUrl: 'https://api.example.com',
      supabaseAnonKey: '"; globalThis.injected = true; //',
      supabaseUrl: 'https://auth.example.com',
    });
  });

  test('keeps static file resolution inside the built frontend directory', () => {
    const publicDirectory = resolve('apps/web/dist');

    expect(resolveStaticFilePath(publicDirectory, '/assets/app.js')).toBe(
      resolve(publicDirectory, 'assets/app.js')
    );
    expect(resolveStaticFilePath(publicDirectory, '/%2e%2e/private.txt')).toBeNull();
  });

  test('rejects API paths at the frontend origin instead of serving the SPA', async () => {
    expect(getFrontendApiMisrouteResponse('/library')).toBeNull();

    const response = getFrontendApiMisrouteResponse('/api/projects/covers/regenerate');
    expect(response).not.toBeNull();
    expect(response?.status).toBe(404);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    await expect(response?.json()).resolves.toEqual({
      success: false,
      error: 'API requests must use the configured backend URL.',
    });
  });

  test('promotes an existing account without discarding its app metadata', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          users: [
            {
              app_metadata: { provider: 'email' },
              email: 'admin@example.com',
              id: 'existing-admin',
            },
          ],
        })
      )
      .mockResolvedValueOnce(Response.json({ id: 'existing-admin' }));

    await expect(bootstrapAdmin(DEPLOYMENT_ENV, request as unknown as typeof fetch)).resolves.toBe(
      'updated'
    );
    expect(request).toHaveBeenLastCalledWith(
      'https://auth-internal.example.com/auth/v1/admin/users/existing-admin',
      expect.objectContaining({
        body: JSON.stringify({
          app_metadata: { provider: 'email', role: 'admin' },
          email: 'admin@example.com',
          email_confirm: true,
          password: 'deployment-secret',
        }),
        method: 'PUT',
      })
    );
  });
});
