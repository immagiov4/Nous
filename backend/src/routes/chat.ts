import { Router, type Request, type Response } from 'express';
import {
  convertToModelMessages,
  jsonSchema,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

import { CONTEXT_CHAT_MODEL, requireOpenRouterApiKey } from '../config/chatConfig.js';
import { getErrorMessage } from '../utils/errors.js';
import { sendErrorResponse } from '../utils/httpResponses.js';

const router = Router();

const MAX_CONTEXT_CHARS = 24_000;

const clip = (value: string | undefined, maxChars = MAX_CONTEXT_CHARS) => {
  if (!value) {
    return '';
  }

  return value.length > maxChars ? `${value.slice(0, maxChars).trim()}\n\n[contesto troncato]` : value;
};

const isUiMessageArray = (value: unknown): value is UIMessage[] => {
  return Array.isArray(value);
};

interface ContextChatToolPreferences {
  annotate?: boolean;
  webSearch?: boolean;
}

interface LibraryChatToolPreferences {
  webSearch?: boolean;
}

interface LibraryContextReference {
  id?: string;
  kind?: string;
  label?: string;
}

interface LibraryResolvedScopeSummary {
  attachedFolderIds?: string[];
  attachedProjectIds?: string[];
  contextLabels?: string[];
  isWholeLibraryScope?: boolean;
  scopeProjectIds?: string[];
  scopeSummary?: string;
}

interface OpenRouterWebSearchAnnotation {
  type?: string;
  url_citation?: {
    title?: string;
    url?: string;
  };
}

interface OpenRouterWebSearchResponse {
  choices?: Array<{
    message?: {
      annotations?: OpenRouterWebSearchAnnotation[];
      content?: string;
    };
  }>;
  usage?: {
    server_tool_use?: {
      web_search_requests?: number;
    };
  };
}

interface WebSearchToolResult {
  error?: string;
  query: string;
  sources: Array<{
    title?: string;
    url: string;
  }>;
  summary: string;
  webSearchRequests: number;
}

const buildContextWebSearchMandate = (toolPreferences?: ContextChatToolPreferences) =>
  toolPreferences?.webSearch
    ? `PRIORITA WEB:
- Le istruzioni esplicite dell'utente hanno precedenza sulla preferenza "Cerca sul web".
- Se l'utente chiede esplicitamente di cercare, verificare, confrontare o fare cross-check sul web, devi usare davvero il tool \`searchWeb\` almeno una volta in questo turno.
- Se l'utente chiede esplicitamente di non usare il web, non usarlo anche se la preferenza e attiva.
- Se l'utente non lo specifica, la preferenza "Cerca sul web" attiva rafforza l'uso di \`searchWeb\` quando fonti esterne, fatti recenti o verifica indipendente migliorano davvero la risposta.
- Se \`searchWeb\` restituisce un errore tecnico, dillo apertamente come errore tecnico di ricerca web; non presentarlo come tool disattivato o non disponibile.`
    : `PRIORITA WEB:
- Le istruzioni esplicite dell'utente hanno precedenza sulla preferenza "Cerca sul web".
- Se l'utente chiede esplicitamente di cercare, verificare, confrontare o fare cross-check sul web, devi usare davvero il tool \`searchWeb\` almeno una volta in questo turno.
- Se l'utente non lo chiede esplicitamente, la preferenza "Cerca sul web" non attiva non vieta il tool: e solo un segnale debole a non usarlo salvo reale bisogno.
- Se \`searchWeb\` restituisce un errore tecnico, dillo apertamente come errore tecnico di ricerca web; non presentarlo come tool disattivato o non disponibile.`;

const buildLibraryWebSearchMandate = (toolPreferences?: LibraryChatToolPreferences) =>
  toolPreferences?.webSearch
    ? `PRIORITA WEB:
- Le istruzioni esplicite dell'utente hanno precedenza sulla preferenza "Cerca sul web".
- Se l'utente chiede esplicitamente di cercare, verificare, confrontare o fare cross-check sul web, devi usare davvero il tool \`searchWeb\` almeno una volta in questo turno.
- Se l'utente chiede esplicitamente di non usare il web, non usarlo anche se la preferenza e attiva.
- Se l'utente non lo specifica, la preferenza "Cerca sul web" attiva rafforza l'uso di \`searchWeb\` quando fonti esterne, fatti recenti o verifica indipendente migliorano davvero la risposta.
- Se \`searchWeb\` restituisce un errore tecnico, dillo apertamente come errore tecnico di ricerca web; non presentarlo come tool disattivato o non disponibile.`
    : `PRIORITA WEB:
- Le istruzioni esplicite dell'utente hanno precedenza sulla preferenza "Cerca sul web".
- Se l'utente chiede esplicitamente di cercare, verificare, confrontare o fare cross-check sul web, devi usare davvero il tool \`searchWeb\` almeno una volta in questo turno.
- Se l'utente non lo chiede esplicitamente, la preferenza "Cerca sul web" non attiva non vieta il tool: e solo un segnale debole a non usarlo salvo reale bisogno.
- Se \`searchWeb\` restituisce un errore tecnico, dillo apertamente come errore tecnico di ricerca web; non presentarlo come tool disattivato o non disponibile.`;

const buildToolNarrationMandate = () => `RENDERING DEI TOOL:
- L interfaccia puo mostrare i tool separatamente dal testo e spesso sopra al messaggio dell assistente.
- Tratta quindi ogni tua risposta come un messaggio unico autosufficiente, anche se il turno viene spezzato da tool call, streaming o piu step consecutivi.
- Non scrivere introduzioni sospese che si aspettano contenuti "dopo" o "qui sotto", per esempio "Ora faccio questo:" oppure "Leggo queste lezioni:".
- Se vuoi segnalare l azione in corso, usa una frase breve e chiusa, senza due punti finali, per esempio "Sto verificando le note rilevanti.".
- Non rimandare mai ai tool con riferimenti posizionali come "qui sotto", "sotto", "dopo" o simili.`;

const getOpenRouterHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${requireOpenRouterApiKey()}`,
  'HTTP-Referer': 'http://localhost:3001',
  'X-OpenRouter-Title': 'Lumina Deep Reader',
});

const LIBRARY_WEB_SEARCH_TOOL_NAME = 'searchWeb' as const;
const LIBRARY_WEB_SEARCH_EXECUTOR_MODEL =
  process.env.MODEL_LIBRARY_WEB_SEARCH || process.env.MODEL_REASONING || 'openai/gpt-5.4-mini';

const formatLibraryAttachedRefs = (attachedContextRefs?: LibraryContextReference[]) =>
  attachedContextRefs && attachedContextRefs.length > 0
    ? attachedContextRefs
        .map(reference => `${reference.kind || 'ref'}:${reference.label || reference.id || 'sconosciuto'}`)
        .join(', ')
    : 'nessun riferimento allegato';

const extractWebSearchSources = (annotations?: OpenRouterWebSearchAnnotation[]) =>
  (annotations || []).reduce<WebSearchToolResult['sources']>((sources, annotation) => {
    if (annotation.type !== 'url_citation') {
      return sources;
    }

    const title = annotation.url_citation?.title?.trim();
    const url = annotation.url_citation?.url?.trim();
    if (!url) {
      return sources;
    }

    sources.push({
      title: title || url,
      url,
    });
    return sources;
  }, []);

const runOpenRouterWebSearch = async ({
  maxResults,
  messages,
  query,
}: {
  maxResults?: number;
  messages: Array<{
    content: string;
    role: 'system' | 'user';
  }>;
  query: string;
}): Promise<WebSearchToolResult> => {
  const normalizedQuery = query.trim();
  const clampedMaxResults = Math.min(Math.max(Math.trunc(maxResults || 5), 1), 8);

  if (!normalizedQuery) {
    return {
      error: 'La query per la ricerca web e vuota.',
      query: '',
      sources: [],
      summary: '',
      webSearchRequests: 0,
    };
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: getOpenRouterHeaders(),
      body: JSON.stringify({
        model: LIBRARY_WEB_SEARCH_EXECUTOR_MODEL,
        max_tokens: 1_200,
        messages,
        tool_choice: 'required',
        tools: [
          {
            type: 'openrouter:web_search',
            parameters: {
              engine: 'auto',
              max_results: clampedMaxResults,
              max_total_results: clampedMaxResults * 2,
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      return {
        error: `Ricerca web fallita: ${details || response.statusText}`,
        query: normalizedQuery,
        sources: [],
        summary: '',
        webSearchRequests: 0,
      };
    }

    const payload = (await response.json()) as OpenRouterWebSearchResponse;
    const webSearchRequests = payload.usage?.server_tool_use?.web_search_requests || 0;
    const summary = payload.choices?.[0]?.message?.content?.trim() || '';
    const sources = extractWebSearchSources(payload.choices?.[0]?.message?.annotations);

    if (webSearchRequests < 1 || !summary) {
      return {
        error: 'La ricerca web non ha restituito un risultato utilizzabile.',
        query: normalizedQuery,
        sources,
        summary,
        webSearchRequests,
      };
    }

    return {
      query: normalizedQuery,
      sources,
      summary,
      webSearchRequests,
    };
  } catch (error) {
    return {
      error: getErrorMessage(error, 'Ricerca web non riuscita.'),
      query: normalizedQuery,
      sources: [],
      summary: '',
      webSearchRequests: 0,
    };
  }
};

const runLibraryWebSearch = async ({
  attachedContextRefs,
  maxResults,
  query,
  resolvedScopeSummary,
}: {
  attachedContextRefs?: LibraryContextReference[];
  maxResults?: number;
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
    query: normalizedQuery,
  });
};

const runContextWebSearch = async ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonTitle,
  maxResults,
  query,
  selectedText,
  sourceKind,
  sourceName,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonTitle?: string;
  maxResults?: number;
  query: string;
  selectedText: string;
  sourceKind?: string;
  sourceName?: string;
}): Promise<WebSearchToolResult> => {
  const normalizedQuery = query.trim();
  const selectionContext = [contextBefore, selectedText, contextAfter].filter(Boolean).join(' ');

  return runOpenRouterWebSearch({
    maxResults,
    messages: [
      {
        role: 'system',
        content: `Sei un ricercatore web per un follow-up didattico nel reader.

Devi usare OBBLIGATORIAMENTE il tool di ricerca web disponibile in questa richiesta.
Non puoi saltare la ricerca.
Restituisci in italiano:
- un paragrafo breve con il cross-check esterno piu utile rispetto alla query;
- 3-5 punti sintetici con fatti o formulazioni esterne rilevanti;
- una sezione finale "Fonti" con link in markdown.`,
      },
      {
        role: 'user',
        content: `Query da verificare:\n${normalizedQuery}\n\nSelezione evidenziata:\n${selectedText}\n\nContesto immediato:\n${selectionContext || selectedText}\n\nTitolo lezione:\n${lessonTitle || 'Lezione corrente'}\n\nPassaggio gia annotato:\n${attachedAnnotationText || 'nessun passaggio gia annotato'}\n\nNota gia associata:\n${attachedAnnotationNote || 'nessuna nota collegata'}\n\nMateriale sorgente:\n${sourceKind || 'non specificato'}${sourceName ? ` - ${sourceName}` : ''}`,
      },
    ],
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
          description:
            'Lista facoltativa di projectId. Se omessa, usa tutto lo scope attuale.',
        },
      },
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  getProjectStructures: tool({
    description:
      'Recupera struttura delle lezioni di uno o piu corsi, inclusi completion state, parentId e conteggi di note/highlight. Utile per capire quali lezioni leggere poi con getLessonDetails.',
    inputSchema: jsonSchema<{
      projectIds: string[];
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
        },
      },
      required: ['projectIds'],
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
  resolvedScopeSummary,
}: {
  attachedContextRefs?: LibraryContextReference[];
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
        query,
        resolvedScopeSummary,
      }),
  });

const libraryLocalToolNames = Object.keys(libraryChatTools) as Array<keyof typeof libraryChatTools>;

const buildLibraryToolSet = ({
  attachedContextRefs,
  resolvedScopeSummary,
}: {
  attachedContextRefs?: LibraryContextReference[];
  resolvedScopeSummary?: LibraryResolvedScopeSummary;
}) => ({
  [LIBRARY_WEB_SEARCH_TOOL_NAME]: createLibrarySearchWebTool({
    attachedContextRefs,
    resolvedScopeSummary,
  }),
  ...libraryChatTools,
});

const buildLibraryPrepareStep = () => {
  return () => ({
    activeTools: [LIBRARY_WEB_SEARCH_TOOL_NAME, ...libraryLocalToolNames],
  });
};

const createContextSearchWebTool = ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonTitle,
  selectedText,
  sourceKind,
  sourceName,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonTitle?: string;
  selectedText: string;
  sourceKind?: string;
  sourceName?: string;
}) =>
  tool({
    description:
      'Esegue un cross-check web esterno sul punto selezionato o sul follow-up corrente. Usalo per verificare accuratezza, confrontare soluzioni, recuperare best practice o informazioni aggiornate. Se l utente chiede esplicitamente una ricerca sul web devi chiamarlo davvero.',
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
            'Query web precisa da usare per il cross-check esterno, formulata in modo specifico rispetto al follow-up.',
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
      runContextWebSearch({
        attachedAnnotationNote,
        attachedAnnotationText,
        contextAfter,
        contextBefore,
        lessonTitle,
        maxResults,
        query,
        selectedText,
        sourceKind,
        sourceName,
      }),
  });

const contextChatTools = {
  requestAddToNotes: tool({
    description:
      "Propone all'utente di salvare un chiarimento riusabile come nota di studio collegata al testo selezionato.",
    inputSchema: jsonSchema<{
      noteDraft: string;
      rationale: string;
      selectedTextDraft: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        noteDraft: {
          type: 'string',
          description:
            'Bozza della nota da salvare: chiara, riusabile e abbastanza sviluppata da restare utile quando verra riletta da sola.',
        },
        rationale: {
          type: 'string',
          description: 'Spiegazione breve del motivo per cui vale la pena salvarla.',
        },
        selectedTextDraft: {
          type: 'string',
          description:
            'Passaggio di testo rifinito da associare alla nota. Deve essere un chunk piu preciso della selezione originale quando serve.',
        },
      },
      required: ['noteDraft', 'rationale', 'selectedTextDraft'],
    }),
    outputSchema: jsonSchema<{ approved: boolean }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        approved: {
          type: 'boolean',
          description: 'True se l\'utente conferma il salvataggio della nota.',
        },
      },
      required: ['approved'],
    }),
  }),
  saveConversationNote: tool({
    description:
      'Salva una nota persistente nella lezione corrente usando il testo selezionato o una sua versione rifinita. Se esistono annotazioni sovrapposte, puo unirle.',
    inputSchema: jsonSchema<{
      contextAfter?: string;
      contextBefore?: string;
      note: string;
      selectedText: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        contextAfter: {
          type: 'string',
          description: 'Contesto facoltativo dopo il passaggio da annotare.',
        },
        contextBefore: {
          type: 'string',
          description: 'Contesto facoltativo prima del passaggio da annotare.',
        },
        note: {
          type: 'string',
          description:
            'Nota finale da salvare nella lezione: chiara, autosufficiente e non telegrafica.',
        },
        selectedText: {
          type: 'string',
          description: 'Passaggio di testo finale da annotare nella lezione.',
        },
      },
      required: ['note', 'selectedText'],
    }),
    outputSchema: jsonSchema<{
      annotationId?: string;
      error?: string;
      merged: boolean;
      resolvedText?: string;
      saved: boolean;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        annotationId: {
          type: 'string',
        },
        error: {
          type: 'string',
        },
        merged: {
          type: 'boolean',
        },
        resolvedText: {
          type: 'string',
        },
        saved: {
          type: 'boolean',
        },
      },
      required: ['merged', 'saved'],
    }),
  }),
  updateConversationNote: tool({
    description:
      'Aggiorna o riscrive una nota gia esistente associata al passaggio corrente, senza concatenarla alla formulazione precedente.',
    inputSchema: jsonSchema<{
      contextAfter?: string;
      contextBefore?: string;
      note: string;
      selectedText: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        contextAfter: {
          type: 'string',
          description: 'Contesto facoltativo dopo il passaggio da annotare.',
        },
        contextBefore: {
          type: 'string',
          description: 'Contesto facoltativo prima del passaggio da annotare.',
        },
        note: {
          type: 'string',
          description:
            'Nuova versione della nota da salvare sul passaggio esistente, riscritta in modo chiaro e autosufficiente.',
        },
        selectedText: {
          type: 'string',
          description: 'Passaggio di testo finale la cui nota esistente deve essere aggiornata.',
        },
      },
      required: ['note', 'selectedText'],
    }),
    outputSchema: jsonSchema<{
      annotationId?: string;
      error?: string;
      merged: boolean;
      resolvedText?: string;
      saved: boolean;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        annotationId: {
          type: 'string',
        },
        error: {
          type: 'string',
        },
        merged: {
          type: 'boolean',
        },
        resolvedText: {
          type: 'string',
        },
        saved: {
          type: 'boolean',
        },
      },
      required: ['merged', 'saved'],
    }),
  }),
} as const;

const contextLocalToolNames = Object.keys(contextChatTools) as Array<keyof typeof contextChatTools>;

const buildContextToolSet = ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonTitle,
  selectedText,
  sourceKind,
  sourceName,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonTitle?: string;
  selectedText: string;
  sourceKind?: string;
  sourceName?: string;
}) => ({
  [LIBRARY_WEB_SEARCH_TOOL_NAME]: createContextSearchWebTool({
    attachedAnnotationNote,
    attachedAnnotationText,
    contextAfter,
    contextBefore,
    lessonTitle,
    selectedText,
    sourceKind,
    sourceName,
  }),
  ...contextChatTools,
});

const buildContextPrepareStep = () => {
  return () => ({
    activeTools: [LIBRARY_WEB_SEARCH_TOOL_NAME, ...contextLocalToolNames],
  });
};

const buildContextSystemPrompt = ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonContent,
  lessonDescription,
  lessonTitle,
  selectedText,
  sourceKind,
  sourceMaterial,
  sourceName,
  toolPreferences,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonContent?: string;
  lessonDescription?: string;
  lessonTitle?: string;
  selectedText: string;
  sourceKind?: string;
  sourceMaterial?: string;
  sourceName?: string;
  toolPreferences?: ContextChatToolPreferences;
}) => {
  const selectionContext = [contextBefore, selectedText, contextAfter].filter(Boolean).join(' ');
  const attachedAnnotationBlock = attachedAnnotationText
    ? `PASSAGGIO GIA ANNOTATO:
"""
${attachedAnnotationText}
"""

NOTA GIA ASSOCIATA:
"""
${attachedAnnotationNote || '[nessuna nota salvata finora]'}
"""`
    : 'NOTA GIA ASSOCIATA:\n[nessuna nota collegata a questa selezione]';

  return `Sei Lumina, un assistente didattico integrato nel reader.

${buildToolNarrationMandate()}

${buildContextWebSearchMandate(toolPreferences)}

Devi rispondere alla conversazione usando come base il contesto seguente:

SELEZIONE EVIDENZIATA:
"""
${selectedText}
"""

CONTESTO IMMEDIATO DELLA SELEZIONE:
"""
${selectionContext || selectedText}
"""

${attachedAnnotationBlock}

TITOLO LEZIONE:
${lessonTitle || 'Lezione corrente'}

DESCRIZIONE LEZIONE:
${lessonDescription || 'Nessuna descrizione disponibile'}

CONTENUTO LEZIONE:
"""
${clip(lessonContent)}
"""

MATERIALE SORGENTE ORIGINALE (${sourceKind || 'non specificato'}${sourceName ? ` - ${sourceName}` : ''}):
"""
${clip(sourceMaterial)}
"""

Regole:
- Rispondi nella lingua usata dall utente nel suo ultimo messaggio. Se non e chiara, usa l italiano.
- Considera i messaggi precedenti come follow-up della stessa domanda.
- Usa il markdown solo quando migliora davvero la leggibilita.
- Spiega in modo accessibile: evita gergo e formulazioni troppo manualistiche quando non servono.
- Se devi usare un termine tecnico necessario, collegalo subito a un significato chiaro e comprensibile.
- Semplifica il modo di spiegare, non il contenuto.
- Se il contesto non basta, dillo chiaramente invece di inventare.
- Se il materiale sorgente originale e presente, preferiscilo come base fattuale quando chiarisce meglio della lezione generata.
- Usa il backtick (\`...\`) SOLO per nomi di funzioni, variabili, classi, comandi e identificatori tecnici. Per citare frasi, titoli o brani usa le virgolette tipografiche (“...”), mai i backtick.
- Rimani concreto e orientato alla spiegazione del punto selezionato.
- Rispondi direttamente alla domanda dell'utente e fermati li. Non aggiungere code conversationali o inviti del tipo "se vuoi posso...", "posso anche...", "dimmi se vuoi..." o simili.
- Non fare domande all'utente, non chiedere chiarimenti e non proporre prossimi passi di tua iniziativa. Se l'utente vuole un altro follow-up, lo chiedera lui.
- L'unica eccezione consentita e una domanda strettamente strumentale all'uso dei tool di annotazione, per esempio la conferma tramite \`requestAddToNotes\`.
- Le istruzioni esplicite dell'utente hanno precedenza sulle preferenze dei tool.
- Il web integra il contesto selezionato e il materiale locale: non sostituisce mai la lettura del passaggio corrente quando il follow-up dipende da esso.
- Quando emerge un chiarimento davvero riusabile durante lo studio, puoi proporre il salvataggio nelle note con il tool \`requestAddToNotes\`.
- Se l'utente ha appena sciolto un dubbio reale, ha corretto un fraintendimento o ha ottenuto una formulazione che sarebbe utile ritrovare rileggendo la lezione, proponi tu in modo proattivo \`requestAddToNotes\` al termine della risposta utile, anche se non te lo chiede esplicitamente.
- Usa \`requestAddToNotes\` solo se la nota sarebbe utile rileggendo la lezione in futuro; non usarlo per dettagli banali o transitori.
- La nota proposta deve essere pulita e utile, non il transcript della conversazione.
- Quando proponi o salvi una nota, non essere telegrafico: in genere scrivi 2-4 frasi complete, abbastanza dense da poter essere capite anche rilette da sole.
- Nella nota esplicita il concetto chiave, l'eventuale distinzione o correzione importante emersa, e perche conta per interpretare bene il passaggio.
- Evita titoletti, bullet list e formule ellittiche da appunto minimo; meglio una breve spiegazione continua, concreta e autosufficiente.
- Prima chiedi sempre conferma con \`requestAddToNotes\`.
- Se l'utente approva, usa \`saveConversationNote\` con una selezione rifinita e ben formata, preferendo il chunk davvero pertinente al dubbio ma senza allontanarti inutilmente dal passaggio originale.
- Se esiste gia una nota collegata al passaggio e l'utente chiede di cambiarla, correggerla, riscriverla, accorciarla o migliorarla, usa \`updateConversationNote\` invece di \`saveConversationNote\`.
- Se l'utente rifiuta, non insistere e continua normalmente.
- Se la preferenza utente "Annota" e attiva, considera molto probabile che voglia salvare o aggiornare una nota utile su questo passaggio e dai forte priorita ai tool di annotazione quando il chiarimento lo giustifica.
- Se la preferenza utente "Cerca sul web" e attiva, trattala come un rafforzamento solo quando l'utente non ha gia dato un'istruzione esplicita sul web.

Preferenze attive:
- Annota: ${toolPreferences?.annotate ? 'attiva' : 'non attiva'}
- Cerca sul web: ${toolPreferences?.webSearch ? 'attiva' : 'non attiva'}`;
};

const buildLibrarySystemPrompt = ({
  attachedContextRefs,
  resolvedScopeSummary,
  toolPreferences,
}: {
  attachedContextRefs?: LibraryContextReference[];
  resolvedScopeSummary?: LibraryResolvedScopeSummary;
  toolPreferences?: LibraryChatToolPreferences;
}) => {
  const contextLabels = resolvedScopeSummary?.contextLabels?.join(', ') || 'nessun allegato esplicito';
  const attachedRefsSummary = formatLibraryAttachedRefs(attachedContextRefs);

  return `Sei Nous, l assistente della libreria corsi locale.

${buildLibraryWebSearchMandate(toolPreferences)}

${buildToolNarrationMandate()}

Obiettivo:
- rispondere interrogando i corsi e le lezioni locali tramite i tool disponibili;
- usare i tool prima di affermare fatti specifici su progresso, contenuti, note, highlight o struttura dei corsi;
- rispettare SEMPRE lo scope locale consentito.

Scope locale attuale:
- ${resolvedScopeSummary?.scopeSummary || 'Nessun riepilogo scope disponibile.'}
- Riferimenti allegati: ${attachedRefsSummary}
- Etichette contesto: ${contextLabels}
- Se non ci sono riferimenti allegati espliciti, l intera libreria locale e gia nello scope. Non dire mai che manca uno scope e non chiedere di allegarne uno.

## Piano di esecuzione autonoma

Quando l utente chiede qualcosa che richiede leggere note, highlight o contenuto delle lezioni, esegui SEMPRE questa sequenza senza fermarti a chiedere chiarimenti o conferme:

1. Chiama \`getProjectStructures\` **in una singola chiamata**, passando TUTTI i projectIds nello scope come array. Non chiamarlo più volta in sequenza per corsi diversi.
2. La risposta include per ogni lezione i campi \`hasContent\`, \`noteCount\`, \`latestNoteAt\` e \`latestAnnotationAt\`.
   - **"Ultima lezione generata"** = l ultima lezione nell array con \`hasContent: true\` (indice di array, non ordine alfabetico).
   - **"Ultima lezione letta / aperta"** = la lezione il cui \`id\` corrisponde a \`activeSectionId\` del corso (campo esposto da \`getProjectStructures\`).
   - **"Ultima nota"** = la lezione con il \`latestNoteAt\` più recente (stringa ISO 8601 comparabile direttamente).
   - **"Ultima nota dell ultima lezione generata"** = leggi la lezione con l indice più alto che ha sia \`hasContent: true\` che \`noteCount > 0\`.
3. Chiama \`getLessonDetails\` SOLO sulla o le lezioni candidate identificate al punto 2, **raggruppando tutte in una singola chiamata** usando il campo \`requests\` (array). Non leggere tutte le lezioni e non chiamarlo più volte in sequenza.
4. Dentro \`getLessonDetails\`, ogni annotation ha \`createdAt\` e \`updatedAt\`. L ultima nota è quella con \`updatedAt\` (o \`createdAt\` se \`updatedAt\` è assente) più recente.
5. Riporta il testo esatto della nota (campo \`note\`) e il testo evidenziato associato (campo \`highlightedText\`), senza parafrasare o inventare.

**IMPORTANTE — questi nomi di campo sono istruzioni interne di esecuzione. Non citarli MAI nella risposta all utente.** Traduci sempre in linguaggio naturale: l utente non deve mai vedere activeSectionId, updatedAt, hasContent, latestNoteAt, annotationId o qualsiasi altro identificatore tecnico.

Non usare \`searchLibrary\` con query vuota o inventata. Usalo solo quando l utente ha fornito un termine di ricerca esplicito.
Non chiedere all utente di scegliere tra approcci di recupero, né chiedere conferme prima di eseguire: esegui il più diretto, poi riporta i dati reali. Se sei fuori scope su un corso, dillo in una frase sola senza esporre dettagli tecnici interni.

## Regole generali

- Rispondi nella lingua usata dall utente nel suo ultimo messaggio. Se non e chiara, usa l italiano.
- Le istruzioni esplicite dell'utente hanno precedenza sulle preferenze dei tool.
- Non fermarti a overview o conteggi quando l utente chiede il contenuto: leggi sempre le lezioni rilevanti con \`getLessonDetails\`.
- Non chiedere all utente di scegliere tra approcci di recupero: esegui il piu diretto, poi riporta i dati.
- Se l utente ha allegato corsi o cartelle, trattali come vincolo forte: non uscire dallo scope locale consentito.
- Se un tool restituisce un errore di scope, non aggirarlo inventando dati: con intera libreria attiva spiega che quel corso non e presente nella libreria corrente; con allegati espliciti spiega che e fuori dallo scope allegato.
- Non mostrare mai identificatori tecnici interni come projectId, lessonId, sectionId, annotationId o simili, a meno che l utente non li chieda esplicitamente. Usa solo titoli, nomi e testi leggibili.
- Le date vanno sempre presentate in formato leggibile in italiano (es. "4 aprile 2026", non ISO 8601).
- Quando citi il titolo di una lezione, di un corso o di una sezione, mettilo sempre tra virgolette: "Titolo della lezione". Non usare il backtick per titoli o testi.
- Usa il backtick (\`...\`) SOLO per nomi di funzioni, variabili, comandi e identificatori tecnici di codice.
- Quando riporti una nota o un highlight dell utente, usa il blockquote markdown (\`> testo\`) senza premettere etichette ridondanti come "Testo nota:" o "Nota:": il blockquote stesso distingue il materiale citato dalla tua analisi. Se ci sono piu citazioni da sorgenti diverse, separa ogni sequenza con la riga orizzontale \`---\` o con un titolo sintetico.
- Integra le informazioni in prosa naturale invece di usare etichette rigide tipo "Ultima sezione evidenziata:", "Ultima nota presa:", "Testo nota:". Racconta in modo fluente.
- Usa markdown solo quando migliora davvero la leggibilita.
- Rispondi in modo diretto e concreto. Niente frasi del tipo "se vuoi posso..." o domande finali non richieste.
- Il web serve per grounding esterno, suggerimenti di nuovi corsi o confronto con argomenti mancanti; non sostituisce mai i tool locali per i dati della libreria.

Preferenze attive:
- Cerca sul web: ${toolPreferences?.webSearch ? 'attiva' : 'non attiva'}
- Scope intera libreria: ${resolvedScopeSummary?.isWholeLibraryScope ? 'si' : 'no'}`;
};

router.post('/library', async (req: Request, res: Response) => {
  try {
    const {
      attachedContextRefs,
      messages,
      resolvedScopeSummary,
      toolPreferences,
    } = req.body as {
      attachedContextRefs?: LibraryContextReference[];
      messages?: UIMessage[];
      resolvedScopeSummary?: LibraryResolvedScopeSummary;
      toolPreferences?: LibraryChatToolPreferences;
    };

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

    const libraryTools = buildLibraryToolSet({
      attachedContextRefs,
      resolvedScopeSummary,
    });

    const modelMessages = await convertToModelMessages(
      messages.map(({ id: _id, ...message }) => message),
      { tools: libraryTools }
    );

    const result = streamText({
      model: openrouter.chat(CONTEXT_CHAT_MODEL),
      system: buildLibrarySystemPrompt({
        attachedContextRefs,
        resolvedScopeSummary,
        toolPreferences,
      }),
      messages: modelMessages,
      tools: libraryTools,
      stopWhen: stepCountIs(6),
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

router.post('/context', async (req: Request, res: Response) => {
  try {
    const {
      attachedAnnotationNote,
      attachedAnnotationText,
      contextAfter,
      contextBefore,
      lessonContent,
      lessonDescription,
      lessonTitle,
      messages,
      selectedText,
      sourceKind,
      sourceMaterial,
      sourceName,
      toolPreferences,
    } = req.body as {
      attachedAnnotationNote?: string;
      attachedAnnotationText?: string;
      contextAfter?: string;
      contextBefore?: string;
      lessonContent?: string;
      lessonDescription?: string;
      lessonTitle?: string;
      messages?: UIMessage[];
      selectedText?: string;
      sourceKind?: string;
      sourceMaterial?: string;
      sourceName?: string;
      toolPreferences?: ContextChatToolPreferences;
    };

    if (!selectedText?.trim()) {
      res.status(400).json({
        success: false,
        error: 'Missing selectedText for contextual chat.',
      });
      return;
    }

    if (!isUiMessageArray(messages) || messages.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing chat messages for contextual chat.',
      });
      return;
    }

    const openrouter = createOpenRouter({
      apiKey: requireOpenRouterApiKey(),
    });

    const contextTools = buildContextToolSet({
      attachedAnnotationNote,
      attachedAnnotationText,
      contextAfter,
      contextBefore,
      lessonTitle,
      selectedText,
      sourceKind,
      sourceName,
    });

    const modelMessages = await convertToModelMessages(
      messages.map(({ id: _id, ...message }) => message),
      { tools: contextTools }
    );

    const result = streamText({
      model: openrouter.chat(CONTEXT_CHAT_MODEL),
      system: buildContextSystemPrompt({
        attachedAnnotationNote,
        attachedAnnotationText,
        contextAfter,
        contextBefore,
        lessonContent,
        lessonDescription,
        lessonTitle,
        selectedText,
        sourceKind,
        sourceMaterial,
        sourceName,
        toolPreferences,
      }),
      messages: modelMessages,
      tools: contextTools,
      stopWhen: stepCountIs(6),
      prepareStep: buildContextPrepareStep(),
    });

    pipeUIMessageStreamToResponse({
      response: res,
      stream: result.toUIMessageStream(),
    });
  } catch (error) {
    console.error('[Chat Route] Error:', error);
    sendErrorResponse(res, 500, error, 'Failed to stream contextual chat response');
  }
});

export default router;
