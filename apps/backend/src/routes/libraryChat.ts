// Handles library-scoped chat requests for the backend API.
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
        content: `You are a web researcher for a course-library chat.

You MUST use the web search tool available in this request.
You may not skip the search.
Return the result in Italian:
- a brief paragraph with the most useful external cross-check for the query;
- 3-5 concise points with relevant external facts or formulations;
- a final "Fonti" section with Markdown links.`,
      },
      {
        role: 'user',
        content: `Query to verify:\n${normalizedQuery}\n\nLibrary-scope summary:\n${resolvedScopeSummary?.scopeSummary || 'No scope summary is available.'}\n\nAttached contexts:\n${formatLibraryAttachedRefs(attachedContextRefs)}\n\nContext labels:\n${resolvedScopeSummary?.contextLabels?.join(', ') || 'no context is attached'}`,
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
    description: 'Explore the folder and course tree currently available in the permitted scope.',
    inputSchema: jsonSchema<{
      includeProjects?: boolean;
    }>({
      type: 'object',
      additionalProperties: false,
      properties: {
        includeProjects: {
          type: 'boolean',
          description:
            'When true, include leaf courses; when false, return only the relevant folder structure.',
        },
      },
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  getProjectOverviews: tool({
    description:
      'Retrieve course overviews and progress for the current scope or specific courses. Use it for counts and progress, not note text.',
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
          description: 'Optional list of projectIds. When omitted, use the entire current scope.',
        },
      },
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  getProjectStructures: tool({
    description:
      'Retrieve the ordered lesson structure of one or more courses, including completion state, parentId, and counts of notes, highlights, and learning aids. When `projectIds` is omitted, use the entire current scope. Use this to resolve structural or ordinal user references such as module 3, chapter 3, or the third lesson before reading content with getLessonDetails.',
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
            'Optional list of real projectIds already returned by library tools. When omitted, use the entire current scope.',
        },
      },
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  getLearningArtifacts: tool({
    description:
      'Retrieve addressable visual artifacts from courses in the current scope: generated maps or widgets and PDF images linked to lessons. Return text metadata only; the UI renders previews separately.',
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
            'Exact filter on artifact IDs returned by a previous call. Use it to render only selected artifacts.',
        },
        kinds: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['future-asset', 'generated-visual', 'pdf-image'],
          },
          description:
            'Filter by artifact type. Use generated-visual for generated maps, charts, or widgets, and pdf-image for images extracted from the PDF.',
        },
        lessonQuery: {
          type: 'string',
          description:
            'Text filter for the source lesson, useful when the user names a lesson, course, or topic to narrow before rendering.',
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
            'Optional list of real projectIds already returned by library tools. When omitted, use the entire current scope.',
        },
        query: {
          type: 'string',
          description:
            'Optional text filter on artifact title, lesson title, caption, or nearby context.',
        },
        renderMode: {
          type: 'string',
          enum: ['attachments', 'metadata-only'],
          description:
            'Default metadata-only returns only metadata for selection. Use attachments only to show the filtered artifacts in chat.',
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
            'Optional requests that limit retrieval to specific lessons in specific courses.',
        },
      },
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  generateLearningArtifact: tool({
    description:
      'Generate a new temporary visual artifact for a specific library lesson. You must know the real projectId and lessonId before calling it; if they are ambiguous, first use getProjectStructures or getLessonDetails, or ask for clarification.',
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
          description: 'Real target lesson ID returned by library tools.',
        },
        mode: {
          type: 'string',
          enum: ['new', 'replacement-draft'],
          description:
            'Use replacement-draft when the user asks to modify or replace an existing artifact. Otherwise use new.',
        },
        projectId: {
          type: 'string',
          description: 'Real target course ID returned by library tools.',
        },
        prompt: {
          type: 'string',
          description:
            'Precise visual request to satisfy, including the concept and desired artifact type when stated.',
        },
        requestedVisualKind: {
          type: 'string',
          enum: ['html', 'image', 'mermaid', 'svg'],
          description:
            'Rendering category explicitly requested by the user: image, svg, mermaid, or html.',
        },
        revisionInstructions: {
          type: 'string',
          description:
            'Required user instructions about what to change when mode is replacement-draft.',
        },
        sourceArtifactId: {
          type: 'string',
          description: 'Exact ID of the source artifact to modify when mode is replacement-draft.',
        },
      },
      required: ['lessonId', 'projectId', 'prompt'],
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  requestSaveLearningArtifactNote: tool({
    description:
      'Propose saving one or more artifacts already generated or shown in home chat to a lesson note. Saving occurs only when the user clicks the confirmation card.',
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
          description: 'IDs of the artifacts to attach to the note.',
        },
        lessonId: {
          type: 'string',
          description: 'Real ID of the lesson where the note will be saved.',
        },
        noteDraft: {
          type: 'string',
          description: 'Self-contained note to save at lesson level.',
        },
        projectId: {
          type: 'string',
          description: 'Real ID of the course where the note will be saved.',
        },
        rationale: {
          type: 'string',
          description: 'Brief rationale shown on the confirmation card.',
        },
      },
      required: ['artifactIds', 'lessonId', 'noteDraft', 'projectId', 'rationale'],
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  startCourseAssessment: tool({
    description:
      'Move from library search to the agentic interview for creating a new course. Use it when searchLibrary has shown that the subject the user wants to learn is absent from the current scope. Base the decision on the meaning of the complete request and the tool results, not isolated keywords. Do not use it for a normal informational question or when a relevant course already exists.',
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
            'Specific subject the user wants to learn, stated without adding a syllabus or invented details.',
        },
      },
      required: ['topic'],
    }),
    outputSchema: genericLibraryToolOutputSchema,
  }),
  getLessonDetails: tool({
    description:
      'Retrieve one or more complete lessons with full content, highlights, notes, and contextual learning aids (definitions, formulas, symbols, and analogies) for a specific course and lessonIds. Also use it for glossary requests.',
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
      'Search titles, descriptions, lesson content, notes, highlights, and learning aids (definitions, formulas, symbols, and analogies) in courses permitted by the current scope.',
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
      'Run an external web cross-check with current sources. When Search the web is active, call it before the final answer. Use it to verify accuracy, standard definitions, best practices, recent facts, or external comparisons. Do not use it to read internal library data, which must be retrieved with library tools.',
    queryDescription:
      'Precise web query for the external cross-check, phrased specifically for the point to verify.',
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
        originalMessages: messages,
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
      stream: result.toUIMessageStream({
        originalMessages: messages,
        generateMessageId: generateId,
        onError: () => SAFE_AI_STREAM_ERROR,
      }),
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
