import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

import { buildSelfHostedUpdates, validateDeploymentConfig } from '../../../../deploy/config.mjs';
import { checkHealthEndpoints } from '../../../../deploy/health-smoke.mjs';
import { bootstrapAdmin } from '../../../../scripts/bootstrap-admin.ts';
import {
  buildRuntimeConfigScript,
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
      OPENROUTER_API_KEY: 'openrouter-test-key',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_JWKS_URL: 'https://alpha-ref.supabase.co/auth/v1/.well-known/jwks.json',
      CORS_ALLOWED_ORIGINS: 'https://reader.acme.test',
    };

    expect(validateDeploymentConfig({ ...baseConfig, SUPABASE_DEPLOYMENT: 'hybrid' })).toContain(
      'SUPABASE_DEPLOYMENT must be managed or self-hosted.'
    );
    expect(validateDeploymentConfig(baseConfig)).toContain(
      'Managed SUPABASE_URL and NOUS_SUPABASE_PUBLIC_URL must use the same project origin.'
    );
    expect(
      validateDeploymentConfig({ ...baseConfig, SUPABASE_URL: baseConfig.NOUS_SUPABASE_PUBLIC_URL })
    ).toEqual([]);
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
      DATABASE_URL: 'postgresql://postgres:generated-postgres-password@db:5432/postgres',
      NOUS_SUPABASE_ANON_KEY: 'generated-publishable-key',
      SUPABASE_JWKS_URL: 'http://kong:8000/auth/v1/.well-known/jwks.json',
      SUPABASE_JWT_SECRET: 'generated-jwt-secret',
      SUPABASE_SERVICE_ROLE_KEY: 'generated-service-key',
      SUPABASE_URL: 'http://kong:8000',
    });
    expect(updates.supabase).toMatchObject({
      API_EXTERNAL_URL: 'https://auth.acme.test/auth/v1',
      SITE_URL: 'https://reader.acme.test',
      SUPABASE_PUBLIC_URL: 'https://auth.acme.test',
    });
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
