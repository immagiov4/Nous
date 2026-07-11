import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
const { createApp } = await import('../../src/index.js');

describe('/api/openrouter proxy', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.CODEX_APP_SERVER_ENABLED = 'true';
    process.env.CODEX_OWNER_USER_ID = 'local-user';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    resetModelConfigForTesting();
    codexMocks.runCodexAppServerTurn.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      body: null,
      headers: new Headers({ 'content-type': 'application/json' }),
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

  test('omits reasoning for models configured without reasoning support', async () => {
    patchGlobalModelConfig({ lessonReasoningEffort: 'none' });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
      .send({
        messages: [{ role: 'user', content: 'Ciao' }],
        reasoning: { effort: 'medium', exclude: false },
      });

    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    const body = JSON.parse(fetchOptions?.body || '{}') as { reasoning?: unknown };
    expect(body.reasoning).toBeUndefined();
  });

  test('maps the common model contract to OpenAI without forwarding OpenRouter-only fields', async () => {
    patchGlobalModelConfig({
      aiProvider: 'openai',
      lessonReasoningEffort: 'high',
      openAiLessonModel: 'gpt-openai-lesson',
    });

    await request(createApp())
      .post('/api/openrouter/chat/completions')
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

  test('maps a non-streaming completion to an ephemeral Codex turn', async () => {
    patchGlobalModelConfig({
      codexLessonModel: 'gpt-codex-lesson',
      lessonReasoningEffort: 'high',
    });
    codexMocks.runCodexAppServerTurn.mockResolvedValue('Risposta Codex');

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-AI-Provider', 'codex')
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

  test('rejects Codex generation for a Nous user other than the configured local owner', async () => {
    process.env.CODEX_OWNER_USER_ID = 'another-user';

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-AI-Provider', 'codex')
      .send({ messages: [{ role: 'user', content: 'Ciao' }] });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      success: false,
      error: 'Codex non è disponibile per questo account.',
    });
    expect(codexMocks.runCodexAppServerTurn).not.toHaveBeenCalled();
  });

  test('translates Codex deltas to the existing OpenAI-compatible SSE contract', async () => {
    patchGlobalModelConfig({ aiProvider: 'codex' });
    codexMocks.runCodexAppServerTurn.mockImplementation(async input => {
      input.onTextDelta?.('Prima ');
      input.onTextDelta?.('parte');
      return 'Prima parte';
    });

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .send({
        messages: [{ role: 'user', content: 'Ciao' }],
        stream: true,
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('"content":"Prima "');
    expect(response.text).toContain('"content":"parte"');
    expect(response.text).toContain('"finish_reason":"stop"');
    expect(response.text).toContain('data: [DONE]');
    expect(fetchMock).not.toHaveBeenCalled();
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

    const response = await request(createApp())
      .post('/api/openrouter/chat/completions')
      .set('X-Nous-AI-Provider', 'codex')
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
