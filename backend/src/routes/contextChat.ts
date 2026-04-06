import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  convertToModelMessages,
  jsonSchema,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { type Request, type Response, Router } from 'express';

import { CONTEXT_CHAT_MODEL, requireOpenRouterApiKey } from '../config/chatConfig.js';
import { sendErrorResponse } from '../utils/httpResponses.js';

import {
  buildContextSystemPrompt,
  buildContextWebSearchMandate,
  buildToolNarrationMandate,
  type ContextChatToolPreferences,
  isUiMessageArray,
  LIBRARY_WEB_SEARCH_TOOL_NAME,
  runOpenRouterWebSearch,
  type WebSearchToolResult,
} from './chatPrompts.js';

const runContextWebSearch = async ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonTitle,
  maxResults,
  modelOverride,
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
  modelOverride?: string;
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
    model: modelOverride,
    query: normalizedQuery,
  });
};

const createContextSearchWebTool = ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonTitle,
  modelOverride,
  selectedText,
  sourceKind,
  sourceName,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonTitle?: string;
  modelOverride?: string;
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
        modelOverride,
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
          description: "True se l'utente conferma il salvataggio della nota.",
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
  modelOverride,
  selectedText,
  sourceKind,
  sourceName,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonTitle?: string;
  modelOverride?: string;
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
    modelOverride,
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

export const contextChatRouter = Router();

contextChatRouter.post('/context', async (req: Request, res: Response) => {
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
      modelOverride,
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
      modelOverride?: string;
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
    const selectedContextModel = modelOverride?.trim() || CONTEXT_CHAT_MODEL;

    const contextTools = buildContextToolSet({
      attachedAnnotationNote,
      attachedAnnotationText,
      contextAfter,
      contextBefore,
      lessonTitle,
      modelOverride: modelOverride?.trim() || undefined,
      selectedText,
      sourceKind,
      sourceName,
    });

    const modelMessages = await convertToModelMessages(
      messages.map(({ id: _id, ...message }) => message),
      { tools: contextTools }
    );

    const result = streamText({
      model: openrouter.chat(selectedContextModel),
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
