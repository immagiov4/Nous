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
  createWebSearchTool,
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

// Local library tools return different payloads, but every payload is still an
// object. Keep the shared schema permissive and enforce input/scope safety in
// the frontend tool executor where the concrete data is produced.
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
  getLearningArtifacts: tool({
    description:
      'Recupera gli artefatti visuali richiamabili dei corsi nello scope corrente: mappe/widget generati e immagini del PDF collegate alle lezioni. Restituisce solo metadati testuali; la UI renderizza le anteprime separatamente.',
    inputSchema: jsonSchema<{
      artifactIds?: string[];
      kinds?: Array<'future-asset' | 'generated-visual' | 'pdf-image'>;
      lessonQuery?: string;
      maxResults?: number;
      projectIds?: string[];
      query?: string;
      renderMode?: 'attachments' | 'metadata-only';
      requests?: Array<{
        lessonIds?: string[];
        projectId: string;
      }>;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        artifactIds: {
          type: 'array',
          items: {
            type: 'string',
          },
          description:
            'Filtro esatto sugli id artefatto gia restituiti da una chiamata precedente. Usalo per renderizzare solo artefatti scelti.',
        },
        kinds: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['future-asset', 'generated-visual', 'pdf-image'],
          },
          description:
            'Filtro per tipo di artefatto. Usa generated-visual per mappe/grafici/widget generati; usa pdf-image per immagini estratte dal PDF.',
        },
        lessonQuery: {
          type: 'string',
          description:
            'Filtro testuale specifico sulla lezione di provenienza, utile quando l utente nomina una lezione o un corso/argomento da restringere prima del rendering.',
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 24,
        },
        projectIds: {
          type: 'array',
          items: {
            type: 'string',
          },
          description:
            'Lista facoltativa di projectId reali gia ottenuti dai tool locali. Se omessa usa tutto lo scope corrente.',
        },
        query: {
          type: 'string',
          description:
            'Filtro testuale facoltativo su titolo artefatto, titolo lezione, didascalia o contesto vicino.',
        },
        renderMode: {
          type: 'string',
          enum: ['attachments', 'metadata-only'],
          description:
            'Default metadata-only: restituisce solo metadati per scegliere. Usa attachments solo quando vuoi mostrare in chat gli artefatti filtrati.',
        },
        requests: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              lessonIds: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              projectId: {
                type: 'string',
              },
            },
            required: ['projectId'],
          },
          description:
            'Richieste facoltative per limitare il recall a lezioni specifiche di corsi specifici.',
        },
      },
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  generateLearningArtifact: tool({
    description:
      'Genera un nuovo artefatto visuale temporaneo per una lezione precisa della libreria. Devi conoscere projectId e lessonId reali prima di chiamarlo: se sono ambigui usa prima getProjectStructures/getLessonDetails o chiedi chiarimento.',
    inputSchema: jsonSchema<{
      lessonId: string;
      projectId: string;
      prompt: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        lessonId: {
          type: 'string',
          description: 'Id reale della lezione target ottenuto dai tool della libreria.',
        },
        projectId: {
          type: 'string',
          description: 'Id reale del corso target ottenuto dai tool della libreria.',
        },
        prompt: {
          type: 'string',
          description:
            'Richiesta visuale precisa da soddisfare, con concetto e tipo di artefatto desiderato se indicato.',
        },
      },
      required: ['lessonId', 'projectId', 'prompt'],
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  requestSaveLearningArtifactNote: tool({
    description:
      'Propone il salvataggio in una nota di lezione di uno o piu artefatti gia generati o mostrati in home chat. Il salvataggio reale avviene solo quando l utente clicca sulla card di conferma.',
    inputSchema: jsonSchema<{
      artifactIds: string[];
      lessonId: string;
      noteDraft: string;
      projectId: string;
      rationale: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        artifactIds: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'string',
          },
          description: 'Id degli artefatti da allegare alla nota.',
        },
        lessonId: {
          type: 'string',
          description: 'Id reale della lezione in cui salvare la nota.',
        },
        noteDraft: {
          type: 'string',
          description: 'Nota autosufficiente da salvare a livello lezione.',
        },
        projectId: {
          type: 'string',
          description: 'Id reale del corso in cui salvare la nota.',
        },
        rationale: {
          type: 'string',
          description: 'Motivo breve mostrato nella card di conferma.',
        },
      },
      required: ['artifactIds', 'lessonId', 'noteDraft', 'projectId', 'rationale'],
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
  createWebSearchTool({
    description:
      'Esegue un cross-check web esterno con fonti aggiornate. Quando Cerca sul web e attiva devi chiamarlo prima della risposta finale. Usalo per verificare accuratezza, definizioni standard, best practice, fatti recenti o confronto esterno. Non usarlo per leggere dati interni della libreria, che vanno recuperati con i tool locali.',
    queryDescription:
      'Query web precisa da usare per il cross-check esterno, formulata in modo specifico rispetto al punto da verificare.',
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
    generateArtifacts: value.generateArtifacts === true,
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
