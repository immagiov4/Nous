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
import { isRecord, readOptionalString } from '../utils/validation.js';

import {
  buildContextSystemPrompt,
  CHAT_TOOL_STEP_LIMIT,
  type ContextChatToolPreferences,
  createWebSearchTool,
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
  createWebSearchTool({
    description:
      'Esegue un cross-check web esterno sul punto selezionato o sul follow-up corrente. Usalo per verificare accuratezza, confrontare soluzioni, recuperare best practice o informazioni aggiornate. Se l utente chiede esplicitamente una ricerca sul web devi chiamarlo davvero.',
    queryDescription:
      'Query web precisa da usare per il cross-check esterno, formulata in modo specifico rispetto al follow-up.',
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
  generateCurrentLessonArtifact: tool({
    description:
      'Genera un nuovo artefatto visuale temporaneo per la lezione corrente in base alla richiesta dell utente. Usalo per mappe concettuali, grafici, diagrammi o widget HTML interattivi richiesti sul momento. Dopo averlo mostrato, se l utente chiede di salvarlo chiama requestAddToNotes includendo artifactIds.',
    inputSchema: jsonSchema<{
      prompt: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          description:
            'Richiesta visuale precisa da soddisfare, includendo concetto, taglio didattico e tipo di artefatto desiderato se indicato.',
        },
      },
      required: ['prompt'],
    }),
    outputSchema: jsonSchema<Record<string, unknown>>({
      type: 'object',
      additionalProperties: true,
      properties: {
        artifact: {
          type: ['object', 'null'],
          additionalProperties: true,
        },
        artifactId: {
          type: 'string',
        },
      },
    }),
  }),
  getCurrentLessonArtifacts: tool({
    description:
      'Recupera gli artefatti visuali gia disponibili nella lezione corrente: mappe/widget generati e immagini PDF collegate. Usalo quando l utente chiede di vedere grafici, mappe, immagini o artefatti esistenti nel follow-up.',
    inputSchema: jsonSchema<{
      artifactIds?: string[];
      kinds?: Array<'future-asset' | 'generated-visual' | 'pdf-image'>;
      maxResults?: number;
      query?: string;
      renderMode?: 'attachments' | 'metadata-only';
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
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 24,
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
      },
    }),
    outputSchema: jsonSchema<Record<string, unknown>>({
      type: 'object',
      additionalProperties: true,
      properties: {
        artifactCount: {
          type: 'integer',
          minimum: 0,
        },
        artifacts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
    }),
  }),
  requestAddToNotes: tool({
    description:
      "Unico tool per proporre il salvataggio di una nota di studio. La UI determina automaticamente se creare una nota nuova o aggiornare quella gia collegata al passaggio: tu non devi scegliere ne distinguere le due modalita. Il salvataggio reale avviene quando l'utente clicca sulla card di conferma; il tool ti restituisce l'esito.",
    inputSchema: jsonSchema<{
      artifactIds?: string[];
      noteDraft: string;
      rationale: string;
      selectedTextDraft: string;
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
            'Id degli artefatti appena generati o recuperati che devono essere allegati alla nota, se l utente vuole salvarli.',
        },
        noteDraft: {
          type: 'string',
          description:
            'Bozza della nota da salvare: chiara, riusabile e abbastanza sviluppata da restare utile quando verra riletta da sola. Deve aggiungere un chiarimento reale rispetto al testo, non limitarsi a ripeterlo o parafrasarlo.',
        },
        rationale: {
          type: 'string',
          description:
            'Spiegazione breve del motivo per cui vale la pena salvarla, indicando quale dubbio scioglie o quale implicito rende esplicito.',
        },
        selectedTextDraft: {
          type: 'string',
          description:
            'Passaggio di testo rifinito da associare alla nota. Deve essere un chunk piu preciso della selezione originale quando serve.',
        },
      },
      required: ['noteDraft', 'rationale', 'selectedTextDraft'],
    }),
    outputSchema: jsonSchema<{
      approved: boolean;
      mode: 'new' | 'update' | 'none';
      saved: boolean;
      annotationId?: string;
      error?: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        approved: {
          type: 'boolean',
          description: "True se l'utente conferma il salvataggio o l'aggiornamento della nota.",
        },
        mode: {
          type: 'string',
          enum: ['new', 'update', 'none'],
          description:
            "Modalita effettiva applicata dalla UI: 'new' se la nota e stata creata, 'update' se aggiornata, 'none' se l'utente ha rifiutato.",
        },
        saved: {
          type: 'boolean',
          description: 'True se il salvataggio o aggiornamento e stato effettivamente persistito.',
        },
        annotationId: {
          type: 'string',
        },
        error: {
          type: 'string',
        },
      },
      required: ['approved', 'mode', 'saved'],
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

const readContextToolPreferences = (value: unknown): ContextChatToolPreferences | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    annotate: value.annotate === true,
    generateArtifacts: value.generateArtifacts === true,
    webSearch: value.webSearch === true,
  };
};

export const contextChatRouter = Router();

contextChatRouter.post('/context', async (req: Request, res: Response) => {
  try {
    if (!isRecord(req.body)) {
      res.status(400).json({
        success: false,
        error: 'Corpo della richiesta non valido.',
      });
      return;
    }

    const {
      attachedAnnotationNote,
      attachedAnnotationText,
      contextAfter,
      contextBefore,
      lessonContent,
      lessonDescription,
      lessonTitle,
      sourceKind,
      sourceMaterial,
      sourceName,
      toolPreferences,
    } = req.body;
    const selectedText = readOptionalString(req.body.selectedText);
    const messages = req.body.messages;
    const modelOverride = readOptionalString(req.body.modelOverride);

    const contextInput = {
      attachedAnnotationNote: readOptionalString(attachedAnnotationNote),
      attachedAnnotationText: readOptionalString(attachedAnnotationText),
      contextAfter: readOptionalString(contextAfter),
      contextBefore: readOptionalString(contextBefore),
      lessonContent: readOptionalString(lessonContent),
      lessonDescription: readOptionalString(lessonDescription),
      lessonTitle: readOptionalString(lessonTitle),
      sourceKind: readOptionalString(sourceKind),
      sourceMaterial: readOptionalString(sourceMaterial),
      sourceName: readOptionalString(sourceName),
      toolPreferences: readContextToolPreferences(toolPreferences),
    };

    if (!selectedText) {
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
    const selectedContextModel = modelOverride || CONTEXT_CHAT_MODEL;

    const contextTools = buildContextToolSet({
      modelOverride,
      selectedText,
      ...contextInput,
    });

    const modelMessages = await convertToModelMessages(
      messages.map(({ id: _id, ...message }) => message),
      { tools: contextTools }
    );

    const result = streamText({
      model: openrouter.chat(selectedContextModel),
      system: buildContextSystemPrompt({
        selectedText,
        ...contextInput,
      }),
      messages: modelMessages,
      tools: contextTools,
      stopWhen: stepCountIs(CHAT_TOOL_STEP_LIMIT),
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
