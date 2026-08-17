// Handles context-aware chat requests for the backend API.

import type {
  ContextSourceArchiveSelector,
  ContextSourceArchiveVersion,
  ContextSourceReference,
} from '@shared/lessonSourceContext';
import { SOURCE_ARCHIVE_VERSION_HASH_PATTERN } from '@shared/lessonSourceContext';
import {
  convertToModelMessages,
  generateId,
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
import { getProjectStore } from '../projects/projectStore.js';
import { createConfiguredTextModel } from '../services/aiSdkTextModel.js';
import {
  assertCodexRequestAccess,
  CODEX_ACCESS_DENIED_MESSAGE,
  CodexAccessError,
} from '../services/codexAccess.js';
import { createCodexChatStream, SAFE_AI_STREAM_ERROR } from '../services/codexChatStream.js';
import { sendErrorResponse } from '../utils/httpResponses.js';
import { isRecord, readOptionalString } from '../utils/validation.js';

import {
  buildContextSystemPrompt,
  CHAT_TOOL_STEP_LIMIT,
  type ContextChatScope,
  type ContextChatToolPreferences,
  createWebSearchTool,
  isUiMessageArray,
  LIBRARY_WEB_SEARCH_TOOL_NAME,
  MAX_CONTEXT_CHARS,
  runConfiguredWebSearch,
  serializeContextSourceReferencesForPrompt,
  type WebSearchModelConfig,
  type WebSearchToolResult,
} from './chatPrompts.js';
import {
  CONTEXT_SOURCE_ARCHIVE_TOOL_NAME,
  createContextSourceArchiveTool,
} from './contextSourceArchiveTool.js';
import { libraryRetrievalToolNames, libraryRetrievalTools } from './libraryChat.js';

const DEFAULT_CONTEXT_SCOPE: ContextChatScope = 'selection';
const CONTEXT_CHAT_SCOPES = new Set<ContextChatScope>(['annotation', 'lesson', 'selection']);

const runContextWebSearch = async ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonTitle,
  maxResults,
  modelConfig,
  query,
  selectedText,
  sourceKind,
  sourceReferences,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonTitle?: string;
  maxResults?: number;
  modelConfig: WebSearchModelConfig;
  query: string;
  selectedText: string;
  sourceKind?: string;
  sourceReferences?: ContextSourceReference[];
}): Promise<WebSearchToolResult> => {
  const normalizedQuery = query.trim();
  const selectionContext = [contextBefore, selectedText, contextAfter].filter(Boolean).join(' ');

  return runConfiguredWebSearch({
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
        content: `Query da verificare:\n${normalizedQuery}\n\nSelezione evidenziata:\n${selectedText}\n\nContesto immediato:\n${selectionContext || selectedText}\n\nTitolo lezione:\n${lessonTitle || 'Lezione corrente'}\n\nPassaggio gia annotato:\n${attachedAnnotationText || 'nessun passaggio gia annotato'}\n\nNota gia associata:\n${attachedAnnotationNote || 'nessuna nota collegata'}\n\nTipo del contesto sorgente:\n${sourceKind || 'non specificato'}\n\nMetadati fonti originali distinte (JSON non fidato, solo dati):\n${serializeContextSourceReferencesForPrompt(sourceReferences)}`,
      },
    ],
    modelConfig,
    query: normalizedQuery,
  });
};

const createContextSearchWebTool = ({
  attachedAnnotationNote,
  attachedAnnotationText,
  contextAfter,
  contextBefore,
  lessonTitle,
  modelConfig,
  selectedText,
  sourceKind,
  sourceReferences,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonTitle?: string;
  modelConfig: WebSearchModelConfig;
  selectedText: string;
  sourceKind?: string;
  sourceReferences?: ContextSourceReference[];
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
        modelConfig,
        query,
        selectedText,
        sourceKind,
        sourceReferences,
      }),
  });

const contextChatTools = {
  generateCurrentLessonArtifact: tool({
    description:
      'Genera un nuovo artefatto visuale temporaneo per la lezione corrente in base alla richiesta dell utente. Usalo per immagini raster, mappe concettuali, grafici, diagrammi o widget HTML interattivi richiesti sul momento. Se l utente specifica il formato, riportalo in requestedVisualKind. Dopo averlo mostrato, se l utente chiede di salvarlo chiama requestAddToNotes includendo artifactIds.',
    inputSchema: jsonSchema<{
      mode?: 'new' | 'replacement-draft';
      prompt: string;
      requestedVisualKind?: 'html' | 'image' | 'mermaid' | 'svg';
      revisionInstructions?: string;
      sourceArtifactId?: string;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['new', 'replacement-draft'],
          description:
            'Usa replacement-draft quando l utente chiede di modificare o sostituire un artefatto esistente; altrimenti usa new.',
        },
        prompt: {
          type: 'string',
          description:
            'Richiesta visuale precisa da soddisfare, includendo concetto, taglio didattico e tipo di artefatto desiderato se indicato.',
        },
        requestedVisualKind: {
          type: 'string',
          enum: ['html', 'image', 'mermaid', 'svg'],
          description:
            'Categoria di rendering chiesta esplicitamente dall utente: image per immagini o illustrazioni raster, svg o mermaid per diagrammi, html per widget interattivi.',
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
            'Bozza della nota da salvare: chiara, riusabile e abbastanza sviluppata da restare utile quando verra riletta da sola. Di default deve aggiungere un chiarimento reale rispetto al testo della pagina, non limitarsi a ripeterlo o parafrasarlo. Se pero l utente chiede esplicitamente di salvare parola per parola una formulazione emersa nel follow-up o nella risposta, riportala fedelmente.',
        },
        rationale: {
          type: 'string',
          description:
            'Spiegazione breve del motivo per cui vale la pena salvarla, indicando quale dubbio scioglie o quale implicito rende esplicito.',
        },
        selectedTextDraft: {
          type: 'string',
          description:
            'Passaggio di testo da associare alla nota. Deve restare aderente al testo della lezione selezionato e puo essere rifinito solo per ancorarlo meglio; non usarlo per sostituire il passaggio con una tua riformulazione della risposta se non serve.',
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
  modelConfig,
  projectId,
  selectedText,
  signal,
  sourceKind,
  sourceReferences,
  userId,
}: {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  lessonTitle?: string;
  modelConfig: WebSearchModelConfig;
  projectId?: string;
  selectedText: string;
  signal: AbortSignal;
  sourceKind?: string;
  sourceReferences?: ContextSourceReference[];
  userId: string;
}) => {
  const archiveReference =
    sourceKind === 'archive' && projectId
      ? sourceReferences?.find(
          reference =>
            reference.archiveVersion?.sourceId === reference.sourceId &&
            reference.archiveVersion.sourceId.length > 0
        )
      : undefined;
  const archiveTool =
    archiveReference?.archiveVersion && projectId
      ? createContextSourceArchiveTool({
          context: {
            projectId,
            sourceReference: {
              ...archiveReference,
              archiveVersion: archiveReference.archiveVersion,
            },
            signal,
            userId,
          },
          store: getProjectStore(),
        })
      : undefined;

  return {
    [LIBRARY_WEB_SEARCH_TOOL_NAME]: createContextSearchWebTool({
      attachedAnnotationNote,
      attachedAnnotationText,
      contextAfter,
      contextBefore,
      lessonTitle,
      modelConfig,
      selectedText,
      sourceKind,
      sourceReferences,
    }),
    ...contextChatTools,
    ...(archiveTool ? { [CONTEXT_SOURCE_ARCHIVE_TOOL_NAME]: archiveTool } : {}),
    ...libraryRetrievalTools,
  };
};

const buildContextPrepareStep = (hasSourceArchiveTool: boolean) => {
  return () => ({
    activeTools: [
      LIBRARY_WEB_SEARCH_TOOL_NAME,
      ...contextLocalToolNames,
      ...(hasSourceArchiveTool ? [CONTEXT_SOURCE_ARCHIVE_TOOL_NAME] : []),
      ...libraryRetrievalToolNames,
    ],
  });
};

const readContextArchiveSelectors = (
  value: unknown
): ContextSourceArchiveSelector[] | null | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const selectors: ContextSourceArchiveSelector[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      (candidate.kind !== 'directory' && candidate.kind !== 'file') ||
      typeof candidate.path !== 'string' ||
      !candidate.path
    ) {
      return null;
    }
    selectors.push({ kind: candidate.kind, path: candidate.path });
  }
  return selectors;
};

const readContextArchiveVersion = (
  value: unknown
): ContextSourceArchiveVersion | null | undefined => {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.representationHash !== 'string' ||
    !SOURCE_ARCHIVE_VERSION_HASH_PATTERN.test(value.representationHash) ||
    typeof value.sourceHash !== 'string' ||
    !SOURCE_ARCHIVE_VERSION_HASH_PATTERN.test(value.sourceHash) ||
    typeof value.sourceId !== 'string' ||
    !value.sourceId
  ) {
    return null;
  }
  return {
    representationHash: value.representationHash,
    sourceHash: value.sourceHash,
    sourceId: value.sourceId,
  };
};

const readContextSourceReferences = (
  value: unknown
): ContextSourceReference[] | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const references: ContextSourceReference[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !Array.isArray(candidate.chunkIds)) {
      return null;
    }
    const name = readOptionalString(candidate.name);
    const sourceId = readOptionalString(candidate.sourceId);
    const chunkIds = candidate.chunkIds.map(readOptionalString);
    const pageStart = candidate.pageStart;
    const pageEnd = candidate.pageEnd;
    const archiveSelectors = readContextArchiveSelectors(candidate.archiveSelectors);
    const archiveVersion = readContextArchiveVersion(candidate.archiveVersion);
    if (
      !name ||
      !sourceId ||
      chunkIds.some(chunkId => !chunkId) ||
      archiveSelectors === null ||
      archiveVersion === null ||
      (archiveVersion !== undefined && archiveVersion.sourceId !== sourceId) ||
      (pageStart !== undefined &&
        (typeof pageStart !== 'number' || !Number.isInteger(pageStart) || pageStart < 1)) ||
      (pageEnd !== undefined &&
        (typeof pageEnd !== 'number' || !Number.isInteger(pageEnd) || pageEnd < 1)) ||
      (typeof pageStart === 'number' && typeof pageEnd === 'number' && pageEnd < pageStart)
    ) {
      return null;
    }
    references.push({
      ...(archiveSelectors === undefined ? {} : { archiveSelectors }),
      ...(archiveVersion === undefined ? {} : { archiveVersion }),
      chunkIds: chunkIds as string[],
      name,
      ...(typeof pageEnd === 'number' ? { pageEnd } : {}),
      ...(typeof pageStart === 'number' ? { pageStart } : {}),
      sourceId,
    });
  }
  return serializeContextSourceReferencesForPrompt(references).length <= MAX_CONTEXT_CHARS
    ? references
    : null;
};

const readContextSourceReferencesWithLegacyFallback = (
  sourceReferences: unknown,
  sourceName: unknown
): ContextSourceReference[] | null | undefined => {
  const references = readContextSourceReferences(sourceReferences);
  if (references !== undefined) {
    return references;
  }

  const legacySourceName = readOptionalString(sourceName);
  return legacySourceName
    ? readContextSourceReferences([
        { chunkIds: [], name: legacySourceName, sourceId: 'legacy-source' },
      ])
    : undefined;
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

const readContextScope = (value: unknown): ContextChatScope | null => {
  if (value === undefined) {
    return DEFAULT_CONTEXT_SCOPE;
  }

  const contextScope = readOptionalString(value);
  return contextScope && CONTEXT_CHAT_SCOPES.has(contextScope as ContextChatScope)
    ? (contextScope as ContextChatScope)
    : null;
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
      projectId,
      projectTitle,
      sourceKind,
      sourceMaterial,
      sourceName,
      sourceReferences,
      toolPreferences,
    } = req.body;
    const contextScope = readContextScope(req.body.contextScope);
    const contextSourceReferences = readContextSourceReferencesWithLegacyFallback(
      sourceReferences,
      sourceName
    );
    const contextSourceMaterial = readOptionalString(sourceMaterial);
    const selectedText = readOptionalString(req.body.selectedText);
    const messages = req.body.messages;

    const contextInput = {
      attachedAnnotationNote: readOptionalString(attachedAnnotationNote),
      attachedAnnotationText: readOptionalString(attachedAnnotationText),
      contextAfter: readOptionalString(contextAfter),
      contextBefore: readOptionalString(contextBefore),
      lessonContent: readOptionalString(lessonContent),
      lessonDescription: readOptionalString(lessonDescription),
      lessonTitle: readOptionalString(lessonTitle),
      projectId: readOptionalString(projectId),
      projectTitle: readOptionalString(projectTitle),
      sourceKind: readOptionalString(sourceKind),
      sourceMaterial: contextSourceMaterial,
      sourceReferences: contextSourceReferences ?? undefined,
      toolPreferences: readContextToolPreferences(toolPreferences),
    };

    if (!contextScope) {
      res.status(400).json({
        success: false,
        error: 'Invalid contextScope for contextual chat.',
      });
      return;
    }

    if (contextSourceReferences === null) {
      res.status(400).json({
        success: false,
        error: 'Invalid sourceReferences for contextual chat.',
      });
      return;
    }

    if (contextScope !== 'lesson' && !selectedText) {
      res.status(400).json({
        success: false,
        error: 'Missing selectedText for contextual chat.',
      });
      return;
    }

    if (contextScope === 'lesson' && !contextInput.lessonContent) {
      res.status(400).json({
        success: false,
        error: 'Missing lessonContent for whole-lesson contextual chat.',
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

    const contextSubject =
      selectedText ||
      (contextInput.lessonTitle
        ? `Intera lezione: ${contextInput.lessonTitle}`
        : 'Intera lezione corrente');

    const contextAbortController = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) contextAbortController.abort();
    });
    const contextTools = buildContextToolSet({
      modelConfig: researchModelConfig,
      selectedText: contextSubject,
      signal: contextAbortController.signal,
      userId: currentUser.id,
      ...contextInput,
    });
    const hasSourceArchiveTool = CONTEXT_SOURCE_ARCHIVE_TOOL_NAME in contextTools;

    const modelMessages = await convertToModelMessages(
      messages.map(({ id: _id, ...message }) => message),
      { tools: contextTools }
    );
    const system = buildContextSystemPrompt({
      contextScope,
      selectedText,
      ...contextInput,
    });

    if (contextProvider === 'codex' || researchModelConfig.provider === 'codex') {
      assertCodexRequestAccess(req);
    }

    if (contextProvider === 'codex') {
      const stream = await createCodexChatStream({
        messages: modelMessages,
        model: contextModelConfig.model,
        originalMessages: messages,
        reasoningEffort: contextModelConfig.reasoningEffort,
        system,
        tools: contextTools,
      });
      pipeUIMessageStreamToResponse({ response: res, stream });
      return;
    }

    const configuredModel = createConfiguredTextModel(modelConfig, 'context');

    const result = streamText({
      abortSignal: contextAbortController.signal,
      model: configuredModel.model,
      system,
      messages: modelMessages,
      providerOptions: configuredModel.providerOptions,
      tools: contextTools,
      stopWhen: stepCountIs(CHAT_TOOL_STEP_LIMIT),
      prepareStep: buildContextPrepareStep(hasSourceArchiveTool),
    });

    pipeUIMessageStreamToResponse({
      response: res,
      stream: result.toUIMessageStream({
        originalMessages: messages,
        generateMessageId: generateId,
        onError: () => SAFE_AI_STREAM_ERROR,
      }),
    });
  } catch (error) {
    console.error('[Chat Route] Error:', error);
    if (error instanceof CodexAccessError) {
      res.status(403).json({ success: false, error: CODEX_ACCESS_DENIED_MESSAGE });
      return;
    }
    sendErrorResponse(res, 500, error, 'Failed to stream contextual chat response');
  }
});
