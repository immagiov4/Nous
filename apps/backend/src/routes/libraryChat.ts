import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  convertToModelMessages,
  jsonSchema,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  tool,
} from 'ai';
import { type Request, type Response, Router } from 'express';

import { CONTEXT_CHAT_MODEL, requireOpenRouterApiKey } from '../config/chatConfig.js';
import { sendErrorResponse } from '../utils/httpResponses.js';
import { isRecord, readOptionalString, readStringArray } from '../utils/validation.js';

import {
  buildLibrarySystemPrompt,
  CHAT_TOOL_STEP_LIMIT,
  formatLibraryAttachedRefs,
  isUiMessageArray,
  LIBRARY_WEB_SEARCH_TOOL_NAME,
  type LibraryChatToolPreferences,
  type LibraryContextReference,
  type LibraryResolvedScopeSummary,
  runOpenRouterWebSearch,
  type WebSearchToolResult,
} from './chatPrompts.js';

const runLibraryWebSearch = async ({
  attachedContextRefs,
  maxResults,
  modelOverride,
  query,
  resolvedScopeSummary,
}: {
  attachedContextRefs?: LibraryContextReference[];
  maxResults?: number;
  modelOverride?: string;
  query: string;
  resolvedScopeSummary?: LibraryResolvedScopeSummary;
}): Promise<WebSearchToolResult> => {
  const normalizedQuery = query.trim();

  return runOpenRouterWebSearch({
    maxResults,
    messages: [
      {
        role: 'system',
        content: `Sei un ricercatore web per una chat di libreria corsi.

Devi usare OBBLIGATORIAMENTE il tool di ricerca web disponibile in questa richiesta.
Non puoi saltare la ricerca.
Restituisci in italiano:
- un paragrafo breve con il cross-check esterno piu utile rispetto alla query;
- 3-5 punti sintetici con fatti o formulazioni esterne rilevanti;
- una sezione finale "Fonti" con link in markdown.`,
      },
      {
        role: 'user',
        content: `Query da verificare:\n${normalizedQuery}\n\nRiepilogo scope libreria:\n${resolvedScopeSummary?.scopeSummary || 'Nessun riepilogo scope disponibile.'}\n\nContesti allegati:\n${formatLibraryAttachedRefs(attachedContextRefs)}\n\nEtichette contesto:\n${resolvedScopeSummary?.contextLabels?.join(', ') || 'nessun contesto allegato'}`,
      },
    ],
    model: modelOverride,
    query: normalizedQuery,
  });
};

const genericLibraryToolOutputSchema = jsonSchema<Record<string, unknown>>({
  type: 'object',
  additionalProperties: true,
  properties: {
    error: {
      type: 'string',
    },
  },
});

const libraryChatTools = {
  listLibraryTree: tool({
    description:
      'Esplora l albero cartelle/corsi attualmente disponibile nello scope locale consentito.',
    inputSchema: jsonSchema<{
      includeProjects?: boolean;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        includeProjects: {
          type: 'boolean',
          description:
            'Se true include anche i corsi foglia; se false restituisce solo la struttura cartelle rilevante.',
        },
      },
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  getProjectOverviews: tool({
    description:
      'Recupera overview e progresso dei corsi nello scope corrente oppure di corsi specifici. Utile per contatori e avanzamento, non per il testo delle note.',
    inputSchema: jsonSchema<{
      projectIds?: string[];
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        projectIds: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Lista facoltativa di projectId. Se omessa, usa tutto lo scope attuale.',
        },
      },
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  getProjectStructures: tool({
    description:
      'Recupera struttura delle lezioni di uno o piu corsi, inclusi completion state, parentId e conteggi di note/highlight. Se `projectIds` e omesso usa tutto lo scope corrente. Utile per capire quali lezioni leggere poi con getLessonDetails.',
    inputSchema: jsonSchema<{
      projectIds?: string[];
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        projectIds: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
          },
          description:
            'Lista facoltativa di projectId reali gia ottenuti da tool locali. Se omessa, usa tutto lo scope corrente.',
        },
      },
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  getLessonDetails: tool({
    description:
      'Recupera una o piu lezioni complete con contenuto integrale, highlight estratti e testo delle note per corso e lessonIds specifici.',
    inputSchema: jsonSchema<{
      requests: Array<{
        lessonIds: string[];
        projectId: string;
      }>;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        requests: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              lessonIds: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'string',
                },
              },
              projectId: {
                type: 'string',
              },
            },
            required: ['lessonIds', 'projectId'],
          },
        },
      },
      required: ['requests'],
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  searchLibrary: tool({
    description:
      'Cerca in titoli, descrizioni, contenuti lezioni, note e highlight nei corsi consentiti dallo scope corrente.',
    inputSchema: jsonSchema<{
      maxResults?: number;
      projectIds?: string[];
      query: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
        },
        projectIds: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        query: {
          type: 'string',
        },
      },
      required: ['query'],
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
} as const;

const createLibrarySearchWebTool = ({
  attachedContextRefs,
  modelOverride,
  resolvedScopeSummary,
}: {
  attachedContextRefs?: LibraryContextReference[];
  modelOverride?: string;
  resolvedScopeSummary?: LibraryResolvedScopeSummary;
}) =>
  tool({
    description:
      'Esegue un cross-check web esterno con fonti aggiornate. Quando Cerca sul web e attiva devi chiamarlo prima della risposta finale. Usalo per verificare accuratezza, definizioni standard, best practice, fatti recenti o confronto esterno. Non usarlo per leggere dati interni della libreria, che vanno recuperati con i tool locali.',
    inputSchema: jsonSchema<{
      maxResults?: number;
      query: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          description: 'Numero massimo di risultati web da consultare.',
        },
        query: {
          type: 'string',
          description:
            'Query web precisa da usare per il cross-check esterno, formulata in modo specifico rispetto al punto da verificare.',
        },
      },
      required: ['query'],
    }),
    outputSchema: jsonSchema<WebSearchToolResult>({
      type: 'object',
      additionalProperties: false,
      properties: {
        error: {
          type: 'string',
        },
        query: {
          type: 'string',
        },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: {
                type: 'string',
              },
              url: {
                type: 'string',
              },
            },
            required: ['url'],
          },
        },
        summary: {
          type: 'string',
        },
        webSearchRequests: {
          type: 'integer',
          minimum: 0,
        },
      },
      required: ['query', 'sources', 'summary', 'webSearchRequests'],
    }),
    execute: async ({ maxResults, query }) =>
      runLibraryWebSearch({
        attachedContextRefs,
        maxResults,
        modelOverride,
        query,
        resolvedScopeSummary,
      }),
  });

const libraryLocalToolNames = Object.keys(libraryChatTools) as Array<keyof typeof libraryChatTools>;

const buildLibraryToolSet = ({
  attachedContextRefs,
  modelOverride,
  resolvedScopeSummary,
}: {
  attachedContextRefs?: LibraryContextReference[];
  modelOverride?: string;
  resolvedScopeSummary?: LibraryResolvedScopeSummary;
}) => ({
  [LIBRARY_WEB_SEARCH_TOOL_NAME]: createLibrarySearchWebTool({
    attachedContextRefs,
    modelOverride,
    resolvedScopeSummary,
  }),
  ...libraryChatTools,
});

const buildLibraryPrepareStep = () => {
  return () => ({
    activeTools: [LIBRARY_WEB_SEARCH_TOOL_NAME, ...libraryLocalToolNames],
  });
};

const readLibraryContextReference = (value: unknown): LibraryContextReference | null => {
  if (!isRecord(value)) {
    return null;
  }

  return {
    id: readOptionalString(value.id),
    kind: readOptionalString(value.kind),
    label: readOptionalString(value.label),
  };
};

const readLibraryContextReferences = (value: unknown): LibraryContextReference[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map(readLibraryContextReference)
    .filter((reference): reference is LibraryContextReference => Boolean(reference));
};

const readLibraryResolvedScopeSummary = (
  value: unknown
): LibraryResolvedScopeSummary | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    attachedFolderIds: readStringArray(value.attachedFolderIds),
    attachedProjectIds: readStringArray(value.attachedProjectIds),
    contextLabels: readStringArray(value.contextLabels),
    isWholeLibraryScope: value.isWholeLibraryScope === true,
    scopeProjectIds: readStringArray(value.scopeProjectIds),
    scopeSummary: readOptionalString(value.scopeSummary),
  };
};

const readLibraryToolPreferences = (value: unknown): LibraryChatToolPreferences | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    webSearch: value.webSearch === true,
  };
};

export const libraryChatRouter = Router();

libraryChatRouter.post('/library', async (req: Request, res: Response) => {
  try {
    if (!isRecord(req.body)) {
      res.status(400).json({
        success: false,
        error: 'Corpo della richiesta non valido.',
      });
      return;
    }

    const messages = req.body.messages;
    const attachedContextRefs = readLibraryContextReferences(req.body.attachedContextRefs);
    const modelOverride = readOptionalString(req.body.modelOverride);
    const resolvedScopeSummary = readLibraryResolvedScopeSummary(req.body.resolvedScopeSummary);
    const toolPreferences = readLibraryToolPreferences(req.body.toolPreferences);

    if (!isUiMessageArray(messages) || messages.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing chat messages for library chat.',
      });
      return;
    }

    const openrouter = createOpenRouter({
      apiKey: requireOpenRouterApiKey(),
    });
    const selectedLibraryModel = modelOverride || CONTEXT_CHAT_MODEL;

    const libraryTools = buildLibraryToolSet({
      attachedContextRefs,
      modelOverride,
      resolvedScopeSummary,
    });

    const modelMessages = await convertToModelMessages(
      messages.map(({ id: _id, ...message }) => message),
      { tools: libraryTools }
    );

    const result = streamText({
      model: openrouter.chat(selectedLibraryModel),
      system: buildLibrarySystemPrompt({
        attachedContextRefs,
        resolvedScopeSummary,
        toolPreferences,
      }),
      messages: modelMessages,
      tools: libraryTools,
      stopWhen: stepCountIs(CHAT_TOOL_STEP_LIMIT),
      prepareStep: buildLibraryPrepareStep(),
    });

    pipeUIMessageStreamToResponse({
      response: res,
      stream: result.toUIMessageStream(),
    });
  } catch (error) {
    console.error('[Library Chat Route] Error:', error);
    sendErrorResponse(res, 500, error, 'Failed to stream library chat response');
  }
});
