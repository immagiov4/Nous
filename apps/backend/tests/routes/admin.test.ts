import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig, resetModelConfigForTesting } from '../../src/config/modelConfig.js';
import { createApp } from '../../src/index.js';
import { createSupabaseTestToken } from '../helpers/auth.js';

const ORIGINAL_ENV = { ...process.env };

const authHeader = (token: string) => `Bearer ${token}`;

describe('/api/admin', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AUTH_MODE: 'supabase',
      OPENROUTER_API_KEY: 'test-openrouter-key',
      SUPABASE_JWT_SECRET: 'test-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    };
    resetModelConfigForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
    resetModelConfigForTesting();
  });

  test('rejects non-admin users before reading global model configuration', async () => {
    const app = createApp();
    const userToken = createSupabaseTestToken({ role: 'user' });

    const response = await request(app)
      .get('/api/admin/model-config')
      .set('Authorization', authHeader(userToken));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      success: false,
      error: 'Solo un amministratore puo eseguire questa operazione.',
    });
  });

  test('lets admins update and read the global model configuration', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/images/models')) {
          return new Response(
            JSON.stringify({
              data: [{ id: 'google/gemini-3.1-flash-lite-image' }],
            }),
            { status: 200 }
          );
        }

        return new Response(JSON.stringify([{ id: 'global' }]), { status: 200 });
      })
    );

    const patchResponse = await request(app)
      .patch('/api/admin/model-config')
      .set('Authorization', authHeader(adminToken))
      .send({
        lessonModel: 'openai/gpt-5.4-mini',
        lessonReasoningEffort: 'high',
        contextModel: 'google/gemini-3.1-flash-lite',
        contextReasoningEffort: 'none',
        imageModel: 'google/gemini-3.1-flash-lite-image',
      });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.config).toMatchObject({
      lessonModel: 'openai/gpt-5.4-mini',
      lessonReasoningEffort: 'high',
      contextModel: 'google/gemini-3.1-flash-lite',
      contextReasoningEffort: 'none',
      imageModel: 'google/gemini-3.1-flash-lite-image',
    });

    const readResponse = await request(app)
      .get('/api/admin/model-config')
      .set('Authorization', authHeader(adminToken));

    expect(readResponse.status).toBe(200);
    expect(readResponse.body.config).toMatchObject({
      lessonModel: 'openai/gpt-5.4-mini',
      lessonReasoningEffort: 'high',
      contextModel: 'google/gemini-3.1-flash-lite',
      contextReasoningEffort: 'none',
      imageModel: 'google/gemini-3.1-flash-lite-image',
    });
  });

  test('rejects a configured model that is absent from the image catalog', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'google/image-capable' }] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .patch('/api/admin/model-config')
      .set('Authorization', authHeader(adminToken))
      .send({ imageModel: 'google/text-only' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(
      'Il modello selezionato non supporta la generazione immagini.'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('persists global model configuration when Postgres storage is active', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 'global',
            },
          ]),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .patch('/api/admin/model-config')
      .set('Authorization', authHeader(adminToken))
      .send({
        artifactInteractiveModel: 'server/interactive-model',
        artifactInteractiveReasoningEffort: 'none',
        contextModel: 'server/context-model',
        contextReasoningEffort: 'low',
      });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/rest/v1/model_config?on_conflict=id',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'service-role-key',
          Authorization: 'Bearer service-role-key',
          Prefer: 'resolution=merge-duplicates,return=representation',
        }),
        body: expect.stringContaining('"id":"global"'),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"artifact_interactive_model":"server/interactive-model"'),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"artifact_interactive_reasoning_effort":"none"'),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"context_model":"server/context-model"'),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"context_reasoning_effort":"low"'),
      })
    );
  });

  test('does not activate a model configuration that Postgres rejected', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const previousContextModel = getGlobalModelConfig().contextModel;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('missing column', { status: 400 }))
    );

    const response = await request(app)
      .patch('/api/admin/model-config')
      .set('Authorization', authHeader(adminToken))
      .send({ contextModel: 'server/rejected-model' });

    expect(response.status).toBe(400);
    expect(getGlobalModelConfig().contextModel).toBe(previousContextModel);
  });

  test('replaces an unavailable persisted TTS model with a working default', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 'global',
                tts_model: 'openai/gpt-4o-mini-tts',
                tts_voice: 'coral',
              },
            ]),
            { status: 200 }
          )
      )
    );

    const response = await request(app)
      .get('/api/admin/model-config')
      .set('Authorization', authHeader(adminToken));

    expect(response.status).toBe(200);
    expect(response.body.config).toMatchObject({
      ttsModel: 'x-ai/grok-voice-tts-1.0',
      ttsVoice: 'Ara',
    });
  });

  test('creates Supabase users through the service-role Admin API only for admins', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'new-user-id',
            email: 'student@example.com',
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .post('/api/admin/users')
      .set('Authorization', authHeader(adminToken))
      .send({
        aiProvider: 'codex',
        email: 'student@example.com',
        password: 'correct horse battery staple',
        role: 'user',
      });

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({
      id: 'new-user-id',
      email: 'student@example.com',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/auth/v1/admin/users',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          apikey: 'service-role-key',
          Authorization: 'Bearer service-role-key',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          email: 'student@example.com',
          password: 'correct horse battery staple',
          email_confirm: true,
          app_metadata: {
            ai_provider: 'codex',
            role: 'user',
          },
        }),
      })
    );
  });

  test('lists Supabase users through the service-role Admin API', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ users: [{ id: 'user-1', email: 'a@example.com' }] }), {
          status: 200,
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .get('/api/admin/users')
      .set('Authorization', authHeader(adminToken));

    expect(response.status).toBe(200);
    expect(response.body.users).toEqual([{ id: 'user-1', email: 'a@example.com' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/auth/v1/admin/users',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          apikey: 'service-role-key',
          Authorization: 'Bearer service-role-key',
        }),
      })
    );
  });

  test('sends a magic link for a Supabase user id without exposing service credentials', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'user-1', email: 'student@example.com' }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .post('/api/admin/users/user-1/magic-link')
      .set('Authorization', authHeader(adminToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      sent: true,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://example.supabase.co/auth/v1/admin/users/user-1',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://example.supabase.co/auth/v1/otp',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'magiclink',
          email: 'student@example.com',
        }),
      })
    );
  });

  test('logs magic-link delivery failures without exposing provider details to the admin', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'user-1', email: 'student@example.com' }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response('provider-secret-diagnostic', { status: 503 }));
    const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .post('/api/admin/users/user-1/magic-link')
      .set('Authorization', authHeader(adminToken));

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      success: false,
      error: 'Invio del link di accesso non riuscito.',
    });
    expect(JSON.stringify(response.body)).not.toContain('provider-secret-diagnostic');
    expect(consoleErrorMock).toHaveBeenCalledWith(
      '[Nous][Admin] Failed to send a Supabase magic link.',
      expect.any(Error)
    );
  });

  test('updates Supabase role, provider, and disabled state through merged metadata', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'user-1', email: 'student@example.com' }), {
          status: 200,
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .patch('/api/admin/users/user-1')
      .set('Authorization', authHeader(adminToken))
      .send({
        aiProvider: 'openai',
        disabled: true,
        role: 'admin',
      });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/auth/v1/admin/users/user-1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          app_metadata: {
            ai_provider: 'openai',
            role: 'admin',
          },
          ban_duration: '876000h',
        }),
      })
    );
  });

  test('lets admins set a user password directly', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'user-1', email: 'student@example.com' }), {
          status: 200,
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .patch('/api/admin/users/user-1')
      .set('Authorization', authHeader(adminToken))
      .send({
        password: 'nuova-password',
      });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/auth/v1/admin/users/user-1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          password: 'nuova-password',
        }),
      })
    );
  });

  test('clears a user provider so the global default applies', async () => {
    const app = createApp();
    const adminToken = createSupabaseTestToken({ role: 'admin' });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'user-1', email: 'student@example.com' }), {
          status: 200,
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(app)
      .patch('/api/admin/users/user-1')
      .set('Authorization', authHeader(adminToken))
      .send({ aiProvider: null });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/auth/v1/admin/users/user-1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          app_metadata: {
            ai_provider: null,
          },
        }),
      })
    );
  });
});
