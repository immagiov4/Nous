// Handles library-scoped chat requests for the backend API.
import {
  convertToModelMessages,
  jsonSchema,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  tool,
} from 'ai';
import { type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  getResolvedModelConfigForProvider,
  resolveAiProviderForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from '../services/aiSdkTextModel.js';
import {
  assertCodexRequestAccess,
  CODEX_ACCESS_DENIED_MESSAGE,
  CodexAccessError,
} from '../services/codexAccess.js';
import { createCodexChatStream, SAFE_AI_STREAM_ERROR } from '../services/codexChatStream.js';
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
  runConfiguredWebSearch,
  type WebSearchModelConfig,
  type WebSearchToolResult,
} from './chatPrompts.js';

const runLibraryWebSearch = async ({
  attachedContextRefs,
  maxResults,
  modelConfig,
  query,
  resolvedScopeSummary,
}: {
  attachedContextRefs?: LibraryContextReference[];
  maxResults?: number;
  modelConfig: WebSearchModelConfig;
  query: string;
  resolvedScopeSummary?: LibraryResolvedScopeSummary;
}): Promise<WebSearchToolResult> => {
  const normalizedQuery = query.trim();

  return runConfiguredWebSearch({
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
    modelConfig,
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
      'Esplora l albero cartelle/corsi attualmente disponibile nello scope corrente consentito.',
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
      'Recupera la struttura ordinata delle lezioni di uno o piu corsi, inclusi completion state, parentId e conteggi di note, highlight e aiuti didattici. Se `projectIds` e omesso usa tutto lo scope corrente. Usalo per risolvere riferimenti strutturali o ordinali espressi dall utente, come modulo 3, capitolo 3 o terza lezione, prima di leggere il contenuto con getLessonDetails.',
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
            'Lista facoltativa di projectId reali gia ottenuti dai tool della libreria. Se omessa, usa tutto lo scope corrente.',
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
            'Lista facoltativa di projectId reali gia ottenuti dai tool della libreria. Se omessa usa tutto lo scope corrente.',
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
      mode?: 'new' | 'replacement-draft';
      projectId: string;
      prompt: string;
      requestedVisualKind?: 'html' | 'image' | 'mermaid' | 'svg';
      revisionInstructions?: string;
      sourceArtifactId?: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        lessonId: {
          type: 'string',
          description: 'Id reale della lezione target ottenuto dai tool della libreria.',
        },
        mode: {
          type: 'string',
          enum: ['new', 'replacement-draft'],
          description:
            'Usa replacement-draft quando l utente chiede di modificare o sostituire un artefatto esistente; altrimenti usa new.',
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
        requestedVisualKind: {
          type: 'string',
          enum: ['html', 'image', 'mermaid', 'svg'],
          description:
            'Categoria di rendering chiesta esplicitamente dall utente: image, svg, mermaid oppure html.',
        },
        revisionInstructions: {
          type: 'string',
          description:
            'Istruzioni obbligatorie dell utente su cosa cambiare quando mode e replacement-draft.',
        },
        sourceArtifactId: {
          type: 'string',
          description:
            'Id esatto dell artefatto sorgente da modificare quando mode e replacement-draft.',
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
  startCourseAssessment: tool({
    description:
      'Passa dalla ricerca nella libreria all intervista agentica per creare un nuovo corso. Usalo quando searchLibrary ha dimostrato che l argomento che l utente vuole imparare non e presente nello scope corrente. La decisione deve derivare dal significato della richiesta completa e dai risultati del tool, non da keyword isolate. Non usarlo per una normale domanda informativa o quando esiste gia un corso pertinente.',
    inputSchema: jsonSchema<{
      topic: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: {
          type: 'string',
          minLength: 1,
          description:
            'Argomento specifico che l utente vuole imparare, formulato senza aggiungere un syllabus o dettagli inventati.',
        },
      },
      required: ['topic'],
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  getLessonDetails: tool({
    description:
      'Recupera una o piu lezioni complete con contenuto integrale, highlight, note e aiuti didattici contestuali (definizioni, formule, simboli e analogie) per corso e lessonIds specifici. Usalo anche per richieste di glossario.',
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
      'Cerca in titoli, descrizioni, contenuti lezioni, note, highlight e aiuti didattici (definizioni, formule, simboli e analogie) nei corsi consentiti dallo scope corrente.',
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

export const libraryRetrievalTools = {
  getLessonDetails: libraryChatTools.getLessonDetails,
  getLearningArtifacts: libraryChatTools.getLearningArtifacts,
  getProjectOverviews: libraryChatTools.getProjectOverviews,
  getProjectStructures: libraryChatTools.getProjectStructures,
  listLibraryTree: libraryChatTools.listLibraryTree,
  searchLibrary: libraryChatTools.searchLibrary,
} as const;

export const libraryRetrievalToolNames = Object.keys(libraryRetrievalTools) as Array<
  keyof typeof libraryRetrievalTools
>;

const createLibrarySearchWebTool = ({
  attachedContextRefs,
  modelConfig,
  resolvedScopeSummary,
}: {
  attachedContextRefs?: LibraryContextReference[];
  modelConfig: WebSearchModelConfig;
  resolvedScopeSummary?: LibraryResolvedScopeSummary;
}) =>
  createWebSearchTool({
    description:
      'Esegue un cross-check web esterno con fonti aggiornate. Quando Cerca sul web e attiva devi chiamarlo prima della risposta finale. Usalo per verificare accuratezza, definizioni standard, best practice, fatti recenti o confronto esterno. Non usarlo per leggere dati interni della libreria, che vanno recuperati con i tool della libreria.',
    queryDescription:
      'Query web precisa da usare per il cross-check esterno, formulata in modo specifico rispetto al punto da verificare.',
    execute: async ({ maxResults, query }) =>
      runLibraryWebSearch({
        attachedContextRefs,
        maxResults,
        modelConfig,
        query,
        resolvedScopeSummary,
      }),
  });

const libraryLocalToolNames = Object.keys(libraryChatTools) as Array<keyof typeof libraryChatTools>;

const buildLibraryToolSet = ({
  attachedContextRefs,
  modelConfig,
  resolvedScopeSummary,
}: {
  attachedContextRefs?: LibraryContextReference[];
  modelConfig: WebSearchModelConfig;
  resolvedScopeSummary?: LibraryResolvedScopeSummary;
}) => ({
  [LIBRARY_WEB_SEARCH_TOOL_NAME]: createLibrarySearchWebTool({
    attachedContextRefs,
    modelConfig,
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
    const resolvedScopeSummary = readLibraryResolvedScopeSummary(req.body.resolvedScopeSummary);
    const toolPreferences = readLibraryToolPreferences(req.body.toolPreferences);

    if (!isUiMessageArray(messages) || messages.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing chat messages for library chat.',
      });
      return;
    }

    const currentUser = getCurrentUser(req);
    const modelConfig = await getResolvedModelConfigForProvider(
      currentUser.aiProvider,
      currentUser.aiProviderOverrides
    );
    const contextModelConfig = resolveTextModelConfig(modelConfig, 'context');
    const contextProvider = resolveAiProviderForSlot(modelConfig, 'context');
    const researchModelConfig = {
      ...resolveTextModelConfig(modelConfig, 'research'),
      provider: resolveAiProviderForSlot(modelConfig, 'research'),
    };

    const libraryTools = buildLibraryToolSet({
      attachedContextRefs,
      modelConfig: researchModelConfig,
      resolvedScopeSummary,
    });

    const modelMessages = await convertToModelMessages(
      messages.map(({ id: _id, ...message }) => message),
      { tools: libraryTools }
    );
    const system = buildLibrarySystemPrompt({
      attachedContextRefs,
      resolvedScopeSummary,
      toolPreferences,
    });

    if (contextProvider === 'codex' || researchModelConfig.provider === 'codex') {
      assertCodexRequestAccess(req);
    }

    if (contextProvider === 'codex') {
      const stream = await createCodexChatStream({
        messages: modelMessages,
        model: contextModelConfig.model,
        reasoningEffort: contextModelConfig.reasoningEffort,
        system,
        tools: libraryTools,
      });
      pipeUIMessageStreamToResponse({ response: res, stream });
      return;
    }

    const configuredModel = createConfiguredTextModel(modelConfig, 'context');

    const result = streamText({
      model: configuredModel.model,
      system,
      messages: modelMessages,
      providerOptions: configuredModel.providerOptions,
      tools: libraryTools,
      stopWhen: stepCountIs(CHAT_TOOL_STEP_LIMIT),
      prepareStep: buildLibraryPrepareStep(),
    });

    pipeUIMessageStreamToResponse({
      response: res,
      stream: result.toUIMessageStream({ onError: () => SAFE_AI_STREAM_ERROR }),
    });
  } catch (error) {
    console.error('[Library Chat Route] Error:', error);
    if (error instanceof CodexAccessError) {
      res.status(403).json({ success: false, error: CODEX_ACCESS_DENIED_MESSAGE });
      return;
    }
    sendErrorResponse(res, 500, error, 'Failed to stream library chat response');
  }
});
