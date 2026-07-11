import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
const ORIGINAL_ENV = { ...process.env };

vi.mock('../../src/config/chatConfig.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/chatConfig.js')>(
    '../../src/config/chatConfig.js'
  );
  return {
    ...actual,
    requireOpenRouterApiKey: () => 'test-openrouter-key',
  };
});

const { patchGlobalModelConfig, resetModelConfigForTesting } = await import(
  '../../src/config/modelConfig.js'
);
const { createApp } = await import('../../src/index.js');

describe('/api/openrouter proxy', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetModelConfigForTesting();
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

  test('loads persisted model config before proxying after a backend restart', async () => {
    process.env.PROJECT_STORAGE_DRIVER = 'postgres';
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
