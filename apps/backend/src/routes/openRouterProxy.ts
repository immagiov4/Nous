// Streams provider responses through the backend-owned AI proxy.
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import { requireOpenAiApiKey, requireOpenRouterApiKey } from '../config/chatConfig.js';
import {
  type AiProvider,
  getResolvedGlobalModelConfig,
  getResolvedModelConfigForProvider,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import {
  assertCodexRequestAccess,
  CODEX_ACCESS_DENIED_MESSAGE,
  CodexAccessError,
} from '../services/codexAccess.js';
import { type CodexTurnTool, runCodexAppServerTurn } from '../services/codexAppServer.js';
import { isRecord } from '../utils/validation.js';

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL_URL = 'https://openrouter.ai/api/v1/model';
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const OPENROUTER_ECONOMY_SERVICE_TIER = 'flex';
const AI_RESPONSE_HEADERS = ['content-type', 'cache-control'] as const;
const openRouterImageSupportByModel = new Map<string, boolean>();
const CODEX_PRODUCT_INSTRUCTIONS =
  'Opera solo come motore didattico di Nous Reader. Non ispezionare file locali, non eseguire comandi e non modificare il computer. Rispetta le istruzioni e i dati forniti nella richiesta.';

const getRequestOrigin = (req: Request): string => {
  const origin = req.get('origin')?.trim();
  if (origin) {
    return origin;
  }

  return `${req.protocol}://${req.get('host') || 'localhost'}`;
};

const forwardOpenRouterHeaders = (req: Request): HeadersInit => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${requireOpenRouterApiKey()}`,
  'HTTP-Referer': getRequestOrigin(req),
  'X-Title': 'Nous Reader',
});

const getOpenAiHeaders = (): HeadersInit => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${requireOpenAiApiKey()}`,
});

type ModelSlot =
  | 'artifact'
  | 'artifactInteractive'
  | 'assessment'
  | 'context'
  | 'lesson'
  | 'progress'
  | 'research';

const readModelSlot = (req: Request): ModelSlot => {
  const slot = req.get('x-nous-model-slot')?.trim();
  return slot === 'artifact' ||
    slot === 'artifactInteractive' ||
    slot === 'assessment' ||
    slot === 'context' ||
    slot === 'progress' ||
    slot === 'research'
    ? slot
    : 'lesson';
};

const resolveProxyConfig = async (req: Request) => {
  const modelSlot = readModelSlot(req);
  const modelConfig = await getResolvedModelConfigForProvider(getCurrentUser(req).aiProvider);
  return {
    modelSlot,
    provider: modelConfig.aiProvider,
    ...resolveTextModelConfig(modelConfig, modelSlot),
  };
};

const readOpenRouterImageSupport = async (model: string): Promise<boolean> => {
  const cachedSupport = openRouterImageSupportByModel.get(model);
  if (cachedSupport !== undefined) {
    return cachedSupport;
  }

  try {
    const response = await fetch(`${OPENROUTER_MODEL_URL}/${model}`, {
      headers: { Authorization: `Bearer ${requireOpenRouterApiKey()}` },
    });
    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as unknown;
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
    const architecture = data && isRecord(data.architecture) ? data.architecture : null;
    const inputModalities = architecture?.input_modalities;
    const supportsImages = Array.isArray(inputModalities) && inputModalities.includes('image');
    openRouterImageSupportByModel.set(model, supportsImages);
    return supportsImages;
  } catch (error) {
    console.warn('[Nous][OpenRouter] Model capabilities unavailable; using text-only fallback.', {
      error,
      model,
    });
    return false;
  }
};

const removeImageInput = (requestBody: Record<string, unknown>): Record<string, unknown> => ({
  ...requestBody,
  messages: Array.isArray(requestBody.messages)
    ? requestBody.messages.map(message => {
        if (!isRecord(message) || !Array.isArray(message.content)) {
          return message;
        }

        return {
          ...message,
          content: message.content.filter(part => !isRecord(part) || part.type !== 'image_url'),
        };
      })
    : requestBody.messages,
});

const hasImageInput = (requestBody: Record<string, unknown>): boolean =>
  Array.isArray(requestBody.messages) &&
  requestBody.messages.some(
    message =>
      isRecord(message) &&
      Array.isArray(message.content) &&
      message.content.some(part => isRecord(part) && part.type === 'image_url')
  );

const buildProxyRequest = async (
  req: Request
): Promise<{ body: Record<string, unknown>; provider: AiProvider }> => {
  const requestBody = isRecord(req.body) ? req.body : {};
  const { model, modelSlot, provider, reasoningEffort } = await resolveProxyConfig(req);

  if (provider === 'openai') {
    const {
      max_tokens: maxTokens,
      plugins: _ignoredPlugins,
      provider: _ignoredProvider,
      reasoning: _ignoredReasoning,
      transforms: _ignoredTransforms,
      ...portableBody
    } = requestBody;
    return {
      provider,
      body: {
        ...portableBody,
        model,
        reasoning_effort: reasoningEffort,
        ...(typeof maxTokens === 'number' ? { max_completion_tokens: maxTokens } : {}),
      },
    };
  }

  if (provider === 'codex') {
    const { reasoning: _ignoredReasoning, ...portableBody } = requestBody;
    return {
      provider,
      body: {
        ...portableBody,
        nous_model_slot: modelSlot,
        model,
        reasoning_effort: reasoningEffort,
      },
    };
  }

  const openRouterRequestBody =
    req.get('x-nous-allow-text-only-image-fallback') === 'true' &&
    hasImageInput(requestBody) &&
    !(await readOpenRouterImageSupport(model))
      ? removeImageInput(requestBody)
      : requestBody;

  if (readModelSlot(req) === 'research') {
    const { reasoning: _ignoredReasoning, ...bodyWithoutReasoning } = openRouterRequestBody;
    return {
      provider,
      body: {
        ...bodyWithoutReasoning,
        model,
        ...(model.startsWith('openai/') ? { service_tier: OPENROUTER_ECONOMY_SERVICE_TIER } : {}),
      },
    };
  }

  const reasoning = isRecord(openRouterRequestBody.reasoning)
    ? openRouterRequestBody.reasoning
    : {};
  return {
    provider,
    body: {
      ...openRouterRequestBody,
      model,
      ...(model.startsWith('openai/') ? { service_tier: OPENROUTER_ECONOMY_SERVICE_TIER } : {}),
      reasoning: {
        ...reasoning,
        enabled: true,
        effort: reasoningEffort,
      },
    },
  };
};

const readChatContent = (content: unknown): { images: string[]; text: string } => {
  if (typeof content === 'string') {
    return { images: [], text: content };
  }
  if (!Array.isArray(content)) {
    return { images: [], text: '' };
  }

  const images: string[] = [];
  const text = content
    .flatMap(part => {
      if (!isRecord(part)) {
        return [];
      }
      if (part.type === 'text' && typeof part.text === 'string') {
        return [part.text];
      }
      if (part.type === 'image_url' && isRecord(part.image_url)) {
        const url = typeof part.image_url.url === 'string' ? part.image_url.url : '';
        if (url) {
          images.push(url);
        }
      }
      return [];
    })
    .join('\n');
  return { images, text };
};

const buildCodexTurnInput = (body: Record<string, unknown>) => {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const developerInstructions: string[] = [CODEX_PRODUCT_INSTRUCTIONS];
  const conversation: string[] = [];
  const images: string[] = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const role = typeof message.role === 'string' ? message.role : 'user';
    const content = readChatContent(message.content);
    images.push(...content.images);
    if (role === 'system' || role === 'developer') {
      if (content.text) {
        developerInstructions.push(content.text);
      }
    } else if (content.text) {
      conversation.push(`${role.toUpperCase()}:\n${content.text}`);
    }
  }

  const responseFormat = isRecord(body.response_format) ? body.response_format : null;
  const jsonSchema =
    responseFormat && isRecord(responseFormat.json_schema)
      ? responseFormat.json_schema.schema
      : undefined;
  return {
    developerInstructions: developerInstructions.join('\n\n'),
    input: [
      { type: 'text' as const, text: conversation.join('\n\n') },
      ...images.map(url => ({ type: 'image' as const, url })),
    ],
    outputSchema: isRecord(jsonSchema) ? jsonSchema : undefined,
  };
};

interface CodexChatToolCall {
  function: { arguments: string; name: string };
  id: string;
  type: 'function';
}

const readCodexChatTools = (value: unknown): CodexTurnTool[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(toolValue => {
    if (!isRecord(toolValue) || toolValue.type !== 'function' || !isRecord(toolValue.function)) {
      return [];
    }
    const name = typeof toolValue.function.name === 'string' ? toolValue.function.name.trim() : '';
    if (!name || !isRecord(toolValue.function.parameters)) {
      return [];
    }
    const description =
      typeof toolValue.function.description === 'string' && toolValue.function.description.trim()
        ? toolValue.function.description
        : name;
    return [
      {
        description,
        inputSchema: toolValue.function.parameters,
        name,
      },
    ];
  });
};

const writeCodexSseChunk = (
  res: Response,
  delta: Record<string, unknown>,
  finishReason: string | null
): void => {
  res.write(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`
  );
};

const sendCodexCompletion = async (body: Record<string, unknown>, res: Response): Promise<void> => {
  const turnInput = buildCodexTurnInput(body);
  const tools = readCodexChatTools(body.tools);
  const toolCalls: CodexChatToolCall[] = [];
  const model = typeof body.model === 'string' ? body.model : '';
  const allowWebSearch = body.nous_model_slot === 'research';
  const reasoningEffort =
    body.reasoning_effort === 'none' ||
    body.reasoning_effort === 'minimal' ||
    body.reasoning_effort === 'low' ||
    body.reasoning_effort === 'medium' ||
    body.reasoning_effort === 'high'
      ? body.reasoning_effort
      : 'medium';

  if (body.stream === true) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const bufferStructuredOutput = turnInput.outputSchema !== undefined;
    let streamed = false;
    const result = await runCodexAppServerTurn({
      ...turnInput,
      allowWebSearch,
      model,
      reasoningEffort,
      tools,
      onReasoningDelta: delta => {
        writeCodexSseChunk(res, { reasoning: delta }, null);
      },
      onTextDelta: delta => {
        if (bufferStructuredOutput) {
          return;
        }
        streamed = true;
        writeCodexSseChunk(res, { content: delta }, null);
      },
      onToolStart: (callId, name, input, execution) => {
        if (execution !== 'client') {
          return;
        }
        const toolCall: CodexChatToolCall = {
          id: callId,
          type: 'function',
          function: { name, arguments: JSON.stringify(input ?? {}) },
        };
        toolCalls.push(toolCall);
        writeCodexSseChunk(
          res,
          {
            tool_calls: [{ index: toolCalls.length - 1, ...toolCall }],
          },
          null
        );
      },
    });
    if ((bufferStructuredOutput || !streamed) && result) {
      writeCodexSseChunk(res, { content: result }, null);
    }
    writeCodexSseChunk(res, {}, toolCalls.length > 0 ? 'tool_calls' : 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const result = await runCodexAppServerTurn({
    ...turnInput,
    allowWebSearch,
    model,
    reasoningEffort,
    tools,
    onToolStart: (callId, name, input, execution) => {
      if (execution === 'client') {
        toolCalls.push({
          id: callId,
          type: 'function',
          function: { name, arguments: JSON.stringify(input ?? {}) },
        });
      }
    },
  });
  res.status(200).json({
    id: 'codex-app-server',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
  });
};

const pipeAiResponse = (upstreamResponse: globalThis.Response, res: Response): void => {
  res.status(upstreamResponse.status);

  for (const headerName of AI_RESPONSE_HEADERS) {
    const headerValue = upstreamResponse.headers.get(headerName);
    if (headerValue) {
      res.setHeader(headerName, headerValue);
    }
  }

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstreamResponse.body as unknown as NodeReadableStream<Uint8Array>).pipe(res);
};

const router = Router();

router.get('/artifact-settings', async (_req: Request, res: Response) => {
  const config = await getResolvedGlobalModelConfig();
  res.json({
    visualReviewEnabled: config.artifactVisualReviewEnabled,
    visualReviewMaxRounds: config.artifactVisualReviewMaxRounds,
  });
});

router.post('/chat/completions', async (req: Request, res: Response) => {
  try {
    const request = await buildProxyRequest(req);
    if (request.provider === 'codex') {
      assertCodexRequestAccess(req);
      await sendCodexCompletion(request.body, res);
      return;
    }
    const upstreamResponse = await fetch(
      request.provider === 'openai' ? OPENAI_CHAT_COMPLETIONS_URL : OPENROUTER_CHAT_COMPLETIONS_URL,
      {
        method: 'POST',
        headers: request.provider === 'openai' ? getOpenAiHeaders() : forwardOpenRouterHeaders(req),
        body: JSON.stringify(request.body),
      }
    );

    pipeAiResponse(upstreamResponse, res);
  } catch (error) {
    console.error('[AI Proxy] Request failed.', {
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    if (error instanceof CodexAccessError && !res.headersSent) {
      res.status(403).json({ success: false, error: CODEX_ACCESS_DENIED_MESSAGE });
      return;
    }
    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({ error: { message: 'Il servizio AI non ha completato la richiesta.' } })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.status(502).json({
      success: false,
      error: 'Il servizio AI non ha completato la richiesta. Riprova tra poco.',
    });
  }
});

export default router;
