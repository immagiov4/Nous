import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createSupabaseTestToken } from '../helpers/auth.js';

const fetchMock = vi.hoisted(() => vi.fn());
const codexMocks = vi.hoisted(() => ({
  runCodexAppServerTurn: vi.fn(),
}));
const ORIGINAL_ENV = { ...process.env };

vi.mock('../../src/config/chatConfig.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/chatConfig.js')>(
    '../../src/config/chatConfig.js'
  );
  return {
    ...actual,
    requireOpenAiApiKey: () => 'test-openai-key',
    requireOpenRouterApiKey: () => 'test-openrouter-key',
  };
});

vi.mock('../../src/services/codexAppServer.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/codexAppServer.js')>(
    '../../src/services/codexAppServer.js'
  );
  return {
    ...actual,
    runCodexAppServerTurn: codexMocks.runCodexAppServerTurn,
  };
});

const { patchGlobalModelConfig, resetModelConfigForTesting } = await import(
  '../../src/config/modelConfig.js'
);
const { CodexAppServerError } = await import('../../src/services/codexAppServer.js');
const { createApp } = await import('../../src/index.js');

const authenticateProvider = (aiProvider: 'codex' | 'openai' | 'openrouter'): string => {
  process.env.AUTH_MODE = 'supabase';
  process.env.SUPABASE_JWT_SECRET = 'test-secret';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  return createSupabaseTestToken({ aiProvider });
};

describe('/api/openrouter proxy', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.CODEX_APP_SERVER_ENABLED = 'true';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    resetModelConfigForTesting();
    codexMocks.runCodexAppServerTurn.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      body: null,
      headers: new Headers({ 'content-type': 'application/json' }),
      ok: true,
      status: 200,
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  test('overrides client-provided models with the backend global slot model', async () => {
    patchGlobalModelConfig({
      assessmentModel: 'server/assessment-model',
      lessonModel: 'server/lesson-model',
    });

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'assessment')
      .send({
        model: 'client/ignored-model',
        messages: [{ role: 'user', content: 'Ciao' }],
      });

    expect(response.status).toBe(200);
    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(fetchOptions?.body).toContain('"model":"server/assessment-model"');
    expect(fetchOptions?.body).not.toContain('client/ignored-model');
  });

  test('records provider-specific AI failures for non-successful upstream responses', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ privateProviderResponse: 'must-not-be-logged' }), {
        headers: { 'content-type': 'application/json' },
        status: 429,
      })
    );

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'lesson')
      .send({ messages: [{ role: 'user', content: 'Ciao' }] });

    expect(response.status).toBe(429);
    const lifecycleFailure = errorLog.mock.calls
      .flat()
      .find(value => typeof value === 'string' && value.includes('"operation":"ai_generation"'));
    expect(lifecycleFailure).toContain('"failureCode":"ai_provider_http_429"');
    expect(lifecycleFailure).toContain('"provider":"openrouter"');
    expect(lifecycleFailure).toContain('"statusCode":429');
    expect(lifecycleFailure).not.toContain('must-not-be-logged');
    errorLog.mockRestore();
  });

  test('keeps sanitized Codex exception details without exposing request payloads', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const correlationId = '423e4567-e89b-42d3-a456-426614174003';
    patchGlobalModelConfig({ aiProvider: 'codex' });
    codexMocks.runCodexAppServerTurn.mockRejectedValueOnce(
      new CodexAppServerError('Codex process failed. api_key=private-key', 'process')
    );

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'lesson')
      .set('x-request-id', correlationId)
      .send({ messages: [{ role: 'user', content: 'PRIVATE_PROMPT_MARKER' }] });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: 'Il servizio AI non ha completato la richiesta. Riprova tra poco.',
      success: false,
    });
    const proxyFailure = errorLog.mock.calls.find(
      ([message]) => message === '[AI Proxy] Request failed.'
    );
    expect(proxyFailure?.[1]).toMatchObject({
      diagnostic: {
        code: 'process',
        message: 'Codex process failed. api_key=[REDACTED]',
        type: 'CodexAppServerError',
      },
    });
    const lifecycleFailure = errorLog.mock.calls
      .flat()
      .find(value => typeof value === 'string' && value.includes('"operation":"ai_generation"'));
    expect(lifecycleFailure).toContain(`"correlationId":"${correlationId}"`);
    expect(lifecycleFailure).toContain('"failureDiagnostic"');
    expect(lifecycleFailure).toContain('"message":"Codex process failed. api_key=[REDACTED]"');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private-key');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('PRIVATE_PROMPT_MARKER');
    errorLog.mockRestore();
  });

  test('rejects missing and unknown model slots instead of defaulting to lesson', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const missingSlotResponse = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .send({ messages: [{ role: 'user', content: 'Ciao' }] });
    const unknownSlotResponse = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'drafting')
      .send({ messages: [{ role: 'user', content: 'Ciao' }] });

    expect(missingSlotResponse.status).toBe(400);
    expect(unknownSlotResponse.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      errorLog.mock.calls
        .flat()
        .some(value => typeof value === 'string' && value.includes('"operation":"ai_generation"'))
    ).toBe(false);
    errorLog.mockRestore();
  });

  test('routes artifact passes through their dedicated model and reasoning slot', async () => {
    patchGlobalModelConfig({
      artifactModel: 'server/artifact-model',
      artifactReasoningEffort: 'low',
      lessonModel: 'server/lesson-model',
    });

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'artifact')
      .send({
        model: 'client/ignored-model',
        messages: [{ role: 'user', content: 'Crea un diagramma' }],
        reasoning: { effort: 'high' },
      });

    expect(response.status).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model?: string;
      reasoning?: { effort?: string };
    };
    expect(body.model).toBe('server/artifact-model');
    expect(body.reasoning?.effort).toBe('low');
  });

  test('routes interactive artifacts through their own model and reasoning slot', async () => {
    patchGlobalModelConfig({
      artifactInteractiveModel: 'server/interactive-artifact-model',
      artifactInteractiveReasoningEffort: 'high',
      artifactModel: 'server/visual-artifact-model',
    });

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'artifactInteractive')
      .send({
        model: 'client/ignored-model',
        messages: [{ role: 'user', content: 'Crea un simulatore' }],
        reasoning: { effort: 'low' },
      });

    expect(response.status).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model?: string;
      reasoning?: { effort?: string };
    };
    expect(body.model).toBe('server/interactive-artifact-model');
    expect(body.reasoning?.effort).toBe('high');
  });

  test('overrides reasoning effort independently for each configured model slot', async () => {
    patchGlobalModelConfig({
      assessmentReasoningEffort: 'low',
      lessonReasoningEffort: 'high',
    });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'lesson')
      .send({
        messages: [{ role: 'user', content: 'Ciao' }],
        reasoning: { effort: 'medium', exclude: false },
      });

    const lessonBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      reasoning?: { effort?: string };
    };
    expect(lessonBody.reasoning?.effort).toBe('high');

    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      body: null,
      headers: new Headers({ 'content-type': 'application/json' }),
      ok: true,
      status: 200,
    });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'assessment')
      .send({
        messages: [{ role: 'user', content: 'Ciao' }],
        reasoning: { effort: 'medium', exclude: false },
      });

    const assessmentBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      reasoning?: { effort?: string };
    };
    expect(assessmentBody.reasoning?.effort).toBe('low');
  });

  test('uses the dedicated fast model for progress summaries', async () => {
    patchGlobalModelConfig({
      progressModel: 'google/progress-model',
      progressReasoningEffort: 'low',
    });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'progress')
      .send({ messages: [{ role: 'user', content: 'Untrusted stream' }] });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model?: string;
      reasoning?: { effort?: string };
    };
    expect(body.model).toBe('google/progress-model');
    expect(body.reasoning?.effort).toBe('low');
  });

  test('uses the configured search model without unsupported reasoning', async () => {
    patchGlobalModelConfig({ researchModel: 'perplexity/custom-search-model' });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'research')
      .send({
        messages: [{ role: 'user', content: 'Cerca fonti aggiornate' }],
        reasoning: { effort: 'high' },
      });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model?: string;
      reasoning?: unknown;
    };
    expect(body.model).toBe('perplexity/custom-search-model');
    expect(body.reasoning).toBeUndefined();
  });

  test('uses the research model with OpenRouter web search for supplemental source research', async () => {
    patchGlobalModelConfig({
      lessonModel: 'openrouter/configured-lesson',
      researchModel: 'perplexity/deep-research',
    });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'research')
      .send({
        messages: [{ role: 'user', content: 'Colma soltanto la lacuna indicata.' }],
        tools: [{ type: 'openrouter:web_search' }],
      });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      model?: string;
      tools?: Array<{ type?: string }>;
    };
    expect(body.model).toBe('perplexity/deep-research');
    expect(body.tools).toEqual([{ type: 'openrouter:web_search' }]);
  });

  test('maps supplemental research to OpenAI Chat Completions search options', async () => {
    patchGlobalModelConfig({
      openAiLessonModel: 'openai/configured-lesson',
      openAiResearchModel: 'gpt-5-search-api',
    });
    const token = authenticateProvider('openai');

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-Model-Slot', 'research')
      .send({
        messages: [{ role: 'user', content: 'Colma soltanto la lacuna indicata.' }],
        tools: [{ type: 'openrouter:web_search' }],
      });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    const rawBody = fetchMock.mock.calls[0]?.[1]?.body as string;
    const body = JSON.parse(rawBody) as {
      model?: string;
      tools?: Array<{ type?: string }>;
      web_search_options?: Record<string, never>;
    };
    expect(body.model).toBe('gpt-5-search-api');
    expect(body.tools).toBeUndefined();
    expect(body.web_search_options).toEqual({});
    expect(rawBody).not.toContain('openrouter:web_search');
  });

  test('rejects an incompatible OpenAI research model before contacting the provider', async () => {
    patchGlobalModelConfig({ openAiResearchModel: 'gpt-5.6-terra' });
    const token = authenticateProvider('openai');

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-Model-Slot', 'research')
      .send({
        messages: [{ role: 'user', content: 'Cerca fonti aggiornate.' }],
        tools: [{ type: 'openrouter:web_search' }],
      });

    expect(response.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sends explicit none effort for artifact reasoning', async () => {
    patchGlobalModelConfig({ artifactReasoningEffort: 'none' });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'artifact')
      .send({
        messages: [{ role: 'user', content: 'Crea un diagramma' }],
        reasoning: { effort: 'medium', exclude: false },
      });

    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(fetchOptions?.body || '{}') as {
      reasoning?: { effort?: string; enabled?: boolean };
    };
    expect(body.reasoning).toEqual({ effort: 'none', enabled: true, exclude: false });
  });

  test('requests the economy service tier for OpenAI models routed through OpenRouter', async () => {
    patchGlobalModelConfig({ lessonModel: 'openai/gpt-5.4-mini' });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'lesson')
      .send({ messages: [{ role: 'user', content: 'Crea una lezione' }] });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      service_tier?: string;
    };
    expect(body.service_tier).toBe('flex');
  });

  test('does not send an OpenAI service tier to other OpenRouter models', async () => {
    patchGlobalModelConfig({ lessonModel: 'google/gemini-3.1-flash-lite' });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'lesson')
      .send({ messages: [{ role: 'user', content: 'Crea una lezione' }] });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      service_tier?: string;
    };
    expect(body.service_tier).toBeUndefined();
  });

  test('sends only artifact heuristics when the configured OpenRouter model is text-only', async () => {
    patchGlobalModelConfig({ artifactModel: 'z-ai/glm-5.2' });
    fetchMock
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            data: { architecture: { input_modalities: ['text'] } },
          }),
        ok: true,
      })
      .mockResolvedValueOnce({
        body: null,
        headers: new Headers({ 'content-type': 'application/json' }),
        ok: true,
        status: 200,
      });

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'artifact')
      .set('X-Nous-Allow-Text-Only-Image-Fallback', 'true')
      .send({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,PREVIEW' } },
              { type: 'text', text: 'Euristica: possibile testo fuori dai bordi.' },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/model/z-ai/glm-5.2');
    const body = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
      messages?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
    };
    expect(body.messages?.[0]?.content).toEqual([
      { type: 'text', text: 'Euristica: possibile testo fuori dai bordi.' },
    ]);
  });

  test('maps the common model contract to OpenAI without forwarding OpenRouter-only fields', async () => {
    patchGlobalModelConfig({
      aiProvider: 'openai',
      lessonReasoningEffort: 'high',
      openAiLessonModel: 'gpt-openai-lesson',
    });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'lesson')
      .send({
        max_tokens: 1234,
        messages: [{ role: 'user', content: 'Ciao' }],
        model: 'client/ignored-model',
        plugins: [{ id: 'web' }],
        provider: { order: ['openai'] },
        reasoning: { effort: 'low' },
      });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    const options = fetchMock.mock.calls[0]?.[1] as {
      body?: string;
      headers?: Record<string, string>;
    };
    expect(options.headers?.Authorization).toBe('Bearer test-openai-key');
    const body = JSON.parse(options.body || '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      max_completion_tokens: 1234,
      model: 'gpt-openai-lesson',
      reasoning_effort: 'high',
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('plugins');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('reasoning');
  });

  test('uses the authenticated user provider instead of a client header', async () => {
    patchGlobalModelConfig({
      aiProvider: 'openrouter',
      openAiLessonModel: 'gpt-authenticated-user',
    });
    const token = authenticateProvider('openai');

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-Model-Slot', 'lesson')
      .set('X-Nous-AI-Provider', 'codex')
      .send({ messages: [{ role: 'user', content: 'Ciao' }] });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"model":"gpt-authenticated-user"');
    expect(codexMocks.runCodexAppServerTurn).not.toHaveBeenCalled();
  });

  test('uses a global provider override only for its configured model slot', async () => {
    patchGlobalModelConfig({
      aiProvider: 'openrouter',
      aiProviderOverrides: { lesson: 'codex' },
      codexLessonModel: 'gpt-mixed-lesson',
    });
    codexMocks.runCodexAppServerTurn.mockResolvedValue('Risposta mista');
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    const token = createSupabaseTestToken();

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-Model-Slot', 'lesson')
      .send({ messages: [{ role: 'user', content: 'Ciao' }] });

    expect(response.status).toBe(200);
    expect(codexMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-mixed-lesson' })
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('maps a non-streaming completion to an ephemeral Codex turn', async () => {
    patchGlobalModelConfig({
      codexLessonModel: 'gpt-codex-lesson',
      lessonReasoningEffort: 'high',
    });
    codexMocks.runCodexAppServerTurn.mockResolvedValue('Risposta Codex');
    const token = authenticateProvider('codex');

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-Model-Slot', 'lesson')
      .send({
        messages: [
          { role: 'system', content: 'Spiega con precisione.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Cosa mostra?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer',
            schema: { type: 'object', properties: { answer: { type: 'string' } } },
          },
        },
      });

    expect(response.status).toBe(200);
    expect(response.headers['x-nous-resolved-ai-provider']).toBe('codex');
    expect(response.headers['x-nous-resolved-ai-model']).toBe('gpt-codex-lesson');
    expect(response.headers['x-nous-resolved-ai-reasoning-effort']).toBe('high');
    expect(response.body.choices[0]).toMatchObject({
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Risposta Codex' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(codexMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-codex-lesson',
        reasoningEffort: 'high',
        input: [
          { type: 'text', text: 'USER:\nCosa mostra?' },
          { type: 'image', url: 'data:image/png;base64,AAAA' },
        ],
        outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      })
    );
  });

  test('authorizes Codex web search only for research and forwards its output schema', async () => {
    patchGlobalModelConfig({ codexResearchModel: 'gpt-codex-research' });
    codexMocks.runCodexAppServerTurn.mockResolvedValue('{"sources":[]}');
    const token = authenticateProvider('codex');

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-Model-Slot', 'research')
      .send({
        messages: [{ role: 'user', content: 'Cerca fonti aggiornate.' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'research_sources',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { sources: { type: 'array', items: { type: 'string' } } },
              required: ['sources'],
            },
          },
        },
      });

    expect(response.status).toBe(200);
    expect(codexMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        allowWebSearch: true,
        model: 'gpt-codex-research',
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { sources: { type: 'array', items: { type: 'string' } } },
          required: ['sources'],
        },
      })
    );
  });

  test('translates Codex deltas to the existing OpenAI-compatible SSE contract', async () => {
    patchGlobalModelConfig({ aiProvider: 'codex' });
    codexMocks.runCodexAppServerTurn.mockImplementation(async input => {
      input.onReasoningDelta?.('Sto ragionando.');
      input.onTextDelta?.('Prima ');
      input.onTextDelta?.('parte');
      return 'Prima parte';
    });

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'lesson')
      .send({
        messages: [{ role: 'user', content: 'Ciao' }],
        stream: true,
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('"reasoning":"Sto ragionando."');
    expect(response.text).toContain('"content":"Prima "');
    expect(response.text).toContain('"content":"parte"');
    expect(response.text).toContain('"finish_reason":"stop"');
    expect(response.text).toContain('data: [DONE]');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('streams the authoritative Codex result for structured output', async () => {
    patchGlobalModelConfig({ aiProvider: 'codex' });
    codexMocks.runCodexAppServerTurn.mockImplementation(async input => {
      input.onReasoningDelta?.('Sto verificando la struttura.');
      input.onTextDelta?.('{"lesson":"bozza incompleta');
      return '{"lesson":"contenuto completo"}';
    });

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'lesson')
      .send({
        messages: [{ role: 'user', content: 'Genera la lezione.' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'lesson',
            schema: {
              type: 'object',
              properties: { lesson: { type: 'string' } },
              required: ['lesson'],
            },
          },
        },
        stream: true,
      });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"reasoning":"Sto verificando la struttura."');
    expect(response.text).toContain('"content":"{\\"lesson\\":\\"contenuto completo\\"}"');
    expect(response.text).not.toContain('bozza incompleta');
    expect(response.text).toContain('"finish_reason":"stop"');
  });

  test('returns Codex client tool calls through the Chat Completions contract', async () => {
    patchGlobalModelConfig({ codexAssessmentModel: 'gpt-codex-assessment' });
    codexMocks.runCodexAppServerTurn.mockImplementation(async input => {
      expect(input.tools).toEqual([
        expect.objectContaining({
          name: 'finalizeProfile',
          inputSchema: expect.objectContaining({ type: 'object' }),
        }),
      ]);
      input.onToolStart?.(
        'profile-call-1',
        'finalizeProfile',
        { topic: 'Grafi', experienceLevel: 'beginner' },
        'client'
      );
      return '';
    });
    const token = authenticateProvider('codex');

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Nous-Model-Slot', 'assessment')
      .send({
        messages: [{ role: 'user', content: 'Ho risposto a tutte le domande.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'finalizeProfile',
              description: 'Finalizza il profilo.',
              parameters: {
                type: 'object',
                properties: {
                  topic: { type: 'string' },
                  experienceLevel: { type: 'string' },
                },
                required: ['topic', 'experienceLevel'],
              },
            },
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'profile-call-1',
            type: 'function',
            function: {
              name: 'finalizeProfile',
              arguments: JSON.stringify({ topic: 'Grafi', experienceLevel: 'beginner' }),
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
  });

  test('loads persisted model config before proxying after a backend restart', async () => {
    process.env.SUPABASE_URL = 'http://supabase.local';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              assessment_model: 'persisted/assessment-model',
              assessment_reasoning_effort: 'low',
              context_model: 'persisted/context-model',
              context_reasoning_effort: 'medium',
              lesson_model: 'persisted/lesson-model',
              lesson_reasoning_effort: 'high',
              tts_model: 'persisted/tts-model',
              tts_voice: 'persisted-voice',
              updated_at: '2026-07-07T10:00:00.000Z',
            },
          ]),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'content-type': 'application/json' },
          status: 200,
        })
      );

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-Model-Slot', 'lesson')
      .send({
        model: 'client/ignored-model',
        messages: [{ role: 'user', content: 'Ciao' }],
      });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://supabase.local/rest/v1/model_config?id=eq.global&limit=1'
    );
    const fetchOptions = fetchMock.mock.calls[1]?.[1] as { body?: string } | undefined;
    expect(fetchOptions?.body).toContain('"model":"persisted/lesson-model"');
    expect(fetchOptions?.body).toContain('"effort":"high"');
    expect(fetchOptions?.body).not.toContain('client/ignored-model');
  });
});
