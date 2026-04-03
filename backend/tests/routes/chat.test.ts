import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const aiMocks = vi.hoisted(() => ({
  convertToModelMessages: vi.fn(),
  pipeUIMessageStreamToResponse: vi.fn(),
  streamText: vi.fn(),
}));

const openRouterMocks = vi.hoisted(() => ({
  createOpenRouter: vi.fn(),
  chat: vi.fn(),
}));

const chatConfigMocks = vi.hoisted(() => ({
  requireOpenRouterApiKey: vi.fn(),
}));

vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    convertToModelMessages: aiMocks.convertToModelMessages,
    pipeUIMessageStreamToResponse: aiMocks.pipeUIMessageStreamToResponse,
    streamText: aiMocks.streamText,
    tool: (definition: unknown) => definition,
    jsonSchema: (schema: unknown) => schema,
  };
});

vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: openRouterMocks.createOpenRouter,
}));

vi.mock('../../src/config/chatConfig.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/chatConfig.js')>(
    '../../src/config/chatConfig.js'
  );
  return {
    ...actual,
    requireOpenRouterApiKey: chatConfigMocks.requireOpenRouterApiKey,
  };
});

const { createApp } = await import('../../src/index.js');

describe('POST /api/chat/context', () => {
  beforeEach(() => {
    aiMocks.convertToModelMessages.mockReset();
    aiMocks.pipeUIMessageStreamToResponse.mockReset();
    aiMocks.streamText.mockReset();
    openRouterMocks.chat.mockReset();
    openRouterMocks.createOpenRouter.mockReset();
    chatConfigMocks.requireOpenRouterApiKey.mockReset();

    chatConfigMocks.requireOpenRouterApiKey.mockReturnValue('test-key');
    openRouterMocks.chat.mockReturnValue('context-model');
    openRouterMocks.createOpenRouter.mockReturnValue({
      chat: openRouterMocks.chat,
    });
    aiMocks.convertToModelMessages.mockResolvedValue([{ role: 'user', content: 'Ciao' }]);
    aiMocks.streamText.mockReturnValue({
      toUIMessageStream: () => 'stream-token',
    });
    aiMocks.pipeUIMessageStreamToResponse.mockImplementation(
      ({ response }: { response: { status: (code: number) => { json: (body: unknown) => void } } }) => {
        response.status(200).json({ success: true, streamed: true });
      }
    );
  });

  test('validates that selected text is present', async () => {
    const response = await request(createApp())
      .post('/api/chat/context')
      .send({ messages: [{ id: '1', role: 'user', content: 'Ciao' }] });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'Missing selectedText for contextual chat.',
    });
  });

  test('validates that chat messages are present', async () => {
    const response = await request(createApp())
      .post('/api/chat/context')
      .send({ selectedText: 'Dato importante' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'Missing chat messages for contextual chat.',
    });
  });

  test('streams a contextual answer with the selected source information', async () => {
    const response = await request(createApp())
      .post('/api/chat/context')
      .send({
        selectedText: 'Puntatore',
        contextBefore: 'testo prima',
        contextAfter: 'testo dopo',
        lessonTitle: 'Lezione 1',
        lessonDescription: 'Descrizione',
        lessonContent: 'Contenuto lezione',
        attachedAnnotationNote: 'Nota gia presente',
        attachedAnnotationText: 'Puntatore',
        sourceKind: 'pdf',
        sourceName: 'dispensa.pdf',
        sourceMaterial: 'Materiale sorgente',
        toolPreferences: {
          annotate: true,
          webSearch: true,
        },
        messages: [{ id: '1', role: 'user', content: 'Spiegami' }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, streamed: true });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
    expect(aiMocks.streamText.mock.calls[0][0]).toMatchObject({
      model: 'context-model',
      messages: [{ role: 'user', content: 'Ciao' }],
    });
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain('Puntatore');
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain('Materiale sorgente');
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain('NOTA GIA ASSOCIATA');
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain('Annota: attiva');
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain('Cerca sul web: attiva');
    expect(aiMocks.streamText.mock.calls[0][0].tools).toMatchObject({
      requestAddToNotes: expect.any(Object),
      saveConversationNote: expect.any(Object),
      updateConversationNote: expect.any(Object),
    });
    expect(aiMocks.streamText.mock.calls[0][0].providerOptions).toMatchObject({
      openrouter: {
        plugins: [
          expect.objectContaining({
            id: 'web',
            max_results: 5,
          }),
        ],
        web_search_options: expect.objectContaining({
          engine: 'native',
          max_results: 5,
        }),
      },
    });
  });
});
