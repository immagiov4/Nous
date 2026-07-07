import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const aiMocks = vi.hoisted(() => ({
  convertToModelMessages: vi.fn(),
  pipeUIMessageStreamToResponse: vi.fn(),
  streamText: vi.fn(),
}));

const fetchMock = vi.hoisted(() => vi.fn());

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
const { patchGlobalModelConfig, resetModelConfigForTesting } = await import(
  '../../src/config/modelConfig.js'
);

describe('POST /api/chat/context', () => {
  beforeEach(() => {
    aiMocks.convertToModelMessages.mockReset();
    aiMocks.pipeUIMessageStreamToResponse.mockReset();
    aiMocks.streamText.mockReset();
    openRouterMocks.chat.mockReset();
    openRouterMocks.createOpenRouter.mockReset();
    chatConfigMocks.requireOpenRouterApiKey.mockReset();
    resetModelConfigForTesting();

    chatConfigMocks.requireOpenRouterApiKey.mockReturnValue('test-key');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    openRouterMocks.chat.mockReturnValue('context-model');
    openRouterMocks.createOpenRouter.mockReturnValue({
      chat: openRouterMocks.chat,
    });
    aiMocks.convertToModelMessages.mockResolvedValue([{ role: 'user', content: 'Ciao' }]);
    aiMocks.streamText.mockReturnValue({
      toUIMessageStream: () => 'stream-token',
    });
    aiMocks.pipeUIMessageStreamToResponse.mockImplementation(
      ({
        response,
      }: {
        response: { status: (code: number) => { json: (body: unknown) => void } };
      }) => {
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

  test('accepts whole-lesson context without selected text', async () => {
    const response = await request(createApp())
      .post('/api/chat/context')
      .send({
        contextScope: 'lesson',
        lessonTitle: 'Lezione sui grafi',
        lessonDescription: 'Introduzione alle mappe concettuali',
        lessonContent: 'Tutta la lezione parla di nodi, archi e percorsi.',
        messages: [{ id: '1', role: 'user', content: 'Generami un riassunto visuale' }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, streamed: true });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain('INTERA LEZIONE CORRENTE');
    expect(aiMocks.streamText.mock.calls[0][0].system).not.toContain('SELEZIONE EVIDENZIATA');
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
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'devi usare davvero il tool `searchWeb` almeno una volta in questo turno'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Tratta quindi ogni tua risposta come un messaggio unico autosufficiente'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Non scrivere introduzioni sospese che si aspettano contenuti "dopo" o "qui sotto"'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      "Rispondi direttamente alla domanda dell'utente e fermati li."
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      "Non fare domande all'utente, non chiedere chiarimenti e non proporre prossimi passi di tua iniziativa."
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      "L'unica eccezione consentita e una domanda strettamente strumentale all'uso del tool di annotazione"
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Di default, la nota non deve limitarsi a ripetere, riassumere o parafrasare cio che e gia chiaramente leggibile nel testo selezionato nella pagina.'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      "Se l'utente chiede di salvare parola per parola un testo emerso nella risposta o nel chiarimento, puoi e devi riportarlo fedelmente in `noteDraft`."
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Non dire mai che il tool di note non puo salvare testo verbatim o citazioni testuali: puo farlo.'
    );
    expect(aiMocks.streamText.mock.calls[0][0].tools).toMatchObject({
      searchWeb: expect.any(Object),
      requestAddToNotes: expect.any(Object),
    });
    expect(aiMocks.streamText.mock.calls[0][0].tools.saveConversationNote).toBeUndefined();
    expect(aiMocks.streamText.mock.calls[0][0].tools.updateConversationNote).toBeUndefined();
    expect(aiMocks.streamText.mock.calls[0][0].providerOptions).toBeUndefined();
    expect(aiMocks.streamText.mock.calls[0][0].stopWhen).toBeDefined();
    expect(typeof aiMocks.streamText.mock.calls[0][0].prepareStep).toBe('function');

    const initialStep = await aiMocks.streamText.mock.calls[0][0].prepareStep({
      steps: [],
    });

    expect(initialStep).toMatchObject({
      activeTools: expect.arrayContaining(['searchWeb', 'requestAddToNotes']),
    });
    expect(initialStep.activeTools).not.toContain('saveConversationNote');
    expect(initialStep.activeTools).not.toContain('updateConversationNote');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    title: 'Example source',
                    url: 'https://example.com/article',
                  },
                },
              ],
              content: 'Cross-check esterno eseguito.',
            },
          },
        ],
        usage: {
          server_tool_use: {
            web_search_requests: 1,
          },
        },
      }),
    });

    const toolResult = await aiMocks.streamText.mock.calls[0][0].tools.searchWeb.execute({
      query: 'NVIDIA forest real-time ray tracing alternatives foliage lighting',
    });

    expect(toolResult).toMatchObject({
      query: 'NVIDIA forest real-time ray tracing alternatives foliage lighting',
      summary: 'Cross-check esterno eseguito.',
      webSearchRequests: 1,
      sources: [
        {
          title: 'Example source',
          url: 'https://example.com/article',
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(fetchOptions?.body).toContain('"type":"openrouter:web_search"');
    expect(fetchOptions?.body).toContain('"tool_choice":"required"');
    expect(fetchOptions?.body).toContain(
      'NVIDIA forest real-time ray tracing alternatives foliage lighting'
    );
    expect(fetchOptions?.body).toContain('Puntatore');
  });

  test('uses the backend global context model instead of a UI override', async () => {
    openRouterMocks.chat.mockImplementation(model => model);
    patchGlobalModelConfig({ contextModel: 'server/context-model' });

    const response = await request(createApp())
      .post('/api/chat/context')
      .send({
        selectedText: 'Puntatore',
        modelOverride: 'openai/gpt-5.4-mini',
        messages: [{ id: '1', role: 'user', content: 'Spiegami' }],
      });

    expect(response.status).toBe(200);
    expect(openRouterMocks.chat).toHaveBeenCalledWith('server/context-model');
    expect(aiMocks.streamText.mock.calls[0][0]).toMatchObject({
      model: 'server/context-model',
    });
  });

  test('uses the backend global context model for contextual web search', async () => {
    patchGlobalModelConfig({ contextModel: 'server/context-model' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              annotations: [],
              content: 'Cross-check esterno eseguito.',
            },
          },
        ],
        usage: {
          server_tool_use: {
            web_search_requests: 1,
          },
        },
      }),
    });

    await request(createApp())
      .post('/api/chat/context')
      .send({
        selectedText: 'Puntatore',
        modelOverride: 'openai/gpt-5.4-nano',
        messages: [{ id: '1', role: 'user', content: 'Spiegami' }],
      });

    await aiMocks.streamText.mock.calls[0][0].tools.searchWeb.execute({
      query: 'pointer aliasing rules',
    });

    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(fetchOptions?.body).toContain('"model":"server/context-model"');
    expect(fetchOptions?.body).not.toContain('"model":"openai/gpt-5.4-nano"');
  });
});

describe('POST /api/chat/library', () => {
  beforeEach(() => {
    aiMocks.convertToModelMessages.mockReset();
    aiMocks.pipeUIMessageStreamToResponse.mockReset();
    aiMocks.streamText.mockReset();
    openRouterMocks.chat.mockReset();
    openRouterMocks.createOpenRouter.mockReset();
    chatConfigMocks.requireOpenRouterApiKey.mockReset();
    resetModelConfigForTesting();

    chatConfigMocks.requireOpenRouterApiKey.mockReturnValue('test-key');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    openRouterMocks.chat.mockReturnValue('context-model');
    openRouterMocks.createOpenRouter.mockReturnValue({
      chat: openRouterMocks.chat,
    });
    aiMocks.convertToModelMessages.mockResolvedValue([{ role: 'user', content: 'Ciao' }]);
    aiMocks.streamText.mockReturnValue({
      toUIMessageStream: () => 'stream-token',
    });
    aiMocks.pipeUIMessageStreamToResponse.mockImplementation(
      ({
        response,
      }: {
        response: { status: (code: number) => { json: (body: unknown) => void } };
      }) => {
        response.status(200).json({ success: true, streamed: true });
      }
    );
  });

  test('validates that library chat messages are present', async () => {
    const response = await request(createApp()).post('/api/chat/library').send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: 'Missing chat messages for library chat.',
    });
  });

  test('streams a library answer with scoped tool contracts and optional web search', async () => {
    const response = await request(createApp())
      .post('/api/chat/library')
      .send({
        attachedContextRefs: [
          {
            id: 'folder-1',
            kind: 'folder',
            label: 'Frontend',
          },
        ],
        resolvedScopeSummary: {
          attachedFolderIds: ['folder-1'],
          attachedProjectIds: [],
          contextLabels: ['Frontend'],
          isWholeLibraryScope: false,
          scopeProjectIds: ['project-1', 'project-2'],
          scopeSummary: '2 corsi nello scope allegato: Frontend.',
        },
        toolPreferences: {
          webSearch: true,
        },
        messages: [{ id: '1', role: 'user', content: 'Riassumimi le note' }],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, streamed: true });
    expect(aiMocks.streamText).toHaveBeenCalledTimes(1);
    expect(aiMocks.streamText.mock.calls[0][0]).toMatchObject({
      model: 'context-model',
      messages: [{ role: 'user', content: 'Ciao' }],
    });
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      '2 corsi nello scope allegato: Frontend.'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'chiama `getProjectStructures` **in una singola chiamata** con un oggetto vuoto `{}`'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Non inventare mai placeholder o alias come `proj_1`, `proj_2` o simili.'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Riferimenti allegati: folder:Frontend'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain('Cerca sul web: attiva');
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Le istruzioni esplicite dell\'utente hanno precedenza sulla preferenza "Cerca sul web".'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Se l\'utente non lo specifica, la preferenza "Cerca sul web" attiva rafforza l\'uso di `searchWeb`'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Tratta quindi ogni tua risposta come un messaggio unico autosufficiente'
    );
    expect(aiMocks.streamText.mock.calls[0][0].system).toContain(
      'Non scrivere introduzioni sospese che si aspettano contenuti "dopo" o "qui sotto"'
    );
    expect(aiMocks.streamText.mock.calls[0][0].tools).toMatchObject({
      searchWeb: expect.any(Object),
      listLibraryTree: expect.any(Object),
      getProjectOverviews: expect.any(Object),
      getProjectStructures: expect.any(Object),
      getLessonDetails: expect.any(Object),
      searchLibrary: expect.any(Object),
    });
    expect(
      aiMocks.streamText.mock.calls[0][0].tools.getProjectStructures.inputSchema.required
    ).toBeUndefined();
    expect(
      aiMocks.streamText.mock.calls[0][0].tools.getProjectStructures.inputSchema.properties
        .projectIds.description
    ).toContain('Se omessa, usa tutto lo scope corrente.');
    expect(aiMocks.streamText.mock.calls[0][0].providerOptions).toBeUndefined();
    expect(aiMocks.streamText.mock.calls[0][0].stopWhen).toBeDefined();
    expect(typeof aiMocks.streamText.mock.calls[0][0].prepareStep).toBe('function');

    const initialStep = await aiMocks.streamText.mock.calls[0][0].prepareStep({
      steps: [],
    });

    expect(initialStep).toMatchObject({
      activeTools: expect.arrayContaining([
        'searchWeb',
        'listLibraryTree',
        'getProjectOverviews',
        'getProjectStructures',
        'getLessonDetails',
        'searchLibrary',
      ]),
    });

    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: {
                    title: 'Example source',
                    url: 'https://example.com/article',
                  },
                },
              ],
              content: 'Cross-check esterno eseguito.',
            },
          },
        ],
        usage: {
          server_tool_use: {
            web_search_requests: 1,
          },
        },
      }),
    });

    const toolResult = await aiMocks.streamText.mock.calls[0][0].tools.searchWeb.execute({
      query: 'NIS2 identity authentication authorization IAM',
    });

    expect(toolResult).toMatchObject({
      query: 'NIS2 identity authentication authorization IAM',
      summary: 'Cross-check esterno eseguito.',
      webSearchRequests: 1,
      sources: [
        {
          title: 'Example source',
          url: 'https://example.com/article',
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(fetchOptions?.body).toContain('"type":"openrouter:web_search"');
    expect(fetchOptions?.body).toContain('"tool_choice":"required"');
    expect(fetchOptions?.body).toContain('NIS2 identity authentication authorization IAM');
  });

  test('keeps the web-search tool available after local library tool activity in the same turn', async () => {
    const response = await request(createApp())
      .post('/api/chat/library')
      .send({
        toolPreferences: {
          webSearch: false,
        },
        messages: [
          {
            id: '1',
            role: 'user',
            parts: [{ type: 'text', text: 'Verifica sul web se la mia ultima nota e accurata' }],
          },
          {
            id: '2',
            role: 'assistant',
            parts: [
              {
                type: 'tool-getLessonDetails',
                toolCallId: 'tool-1',
                state: 'output-available',
                input: {
                  requests: [{ projectId: 'project-1', lessonIds: ['lesson-1'] }],
                },
                output: {
                  lessons: [],
                },
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    const forcedWebStep = await aiMocks.streamText.mock.calls[0][0].prepareStep({
      steps: [],
    });

    expect(forcedWebStep).toMatchObject({
      activeTools: expect.arrayContaining([
        'searchWeb',
        'listLibraryTree',
        'getProjectOverviews',
        'getProjectStructures',
        'getLessonDetails',
        'searchLibrary',
      ]),
    });
  });

  test('uses the backend global context model for library chat', async () => {
    openRouterMocks.chat.mockImplementation(model => model);
    patchGlobalModelConfig({ contextModel: 'server/library-model' });

    const response = await request(createApp())
      .post('/api/chat/library')
      .send({
        modelOverride: 'openai/gpt-5.4-mini',
        messages: [{ id: '1', role: 'user', content: 'Riassumimi le note' }],
      });

    expect(response.status).toBe(200);
    expect(openRouterMocks.chat).toHaveBeenCalledWith('server/library-model');
    expect(aiMocks.streamText.mock.calls[0][0]).toMatchObject({
      model: 'server/library-model',
    });
  });

  test('uses the backend global context model for library web search', async () => {
    patchGlobalModelConfig({ contextModel: 'server/library-model' });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              annotations: [],
              content: 'Cross-check esterno eseguito.',
            },
          },
        ],
        usage: {
          server_tool_use: {
            web_search_requests: 1,
          },
        },
      }),
    });

    await request(createApp())
      .post('/api/chat/library')
      .send({
        modelOverride: 'openai/gpt-5.4-nano',
        messages: [{ id: '1', role: 'user', content: 'Riassumimi le note' }],
      });

    await aiMocks.streamText.mock.calls[0][0].tools.searchWeb.execute({
      query: 'nis2 identity access management summary',
    });

    const fetchOptions = fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(fetchOptions?.body).toContain('"model":"server/library-model"');
    expect(fetchOptions?.body).not.toContain('"model":"openai/gpt-5.4-nano"');
  });
});
