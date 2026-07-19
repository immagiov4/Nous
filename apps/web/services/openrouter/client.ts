import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl, MAX_OUTPUT_TOKENS, resolveOpenRouterModel } from './config.ts';
import {
  measureUtf8Bytes,
  OPENROUTER_PAYLOAD_TOO_LARGE_MESSAGE,
  OPENROUTER_SAFE_JSON_BODY_BYTES,
} from './payloadLimits.ts';
import type {
  ChatAnnotation,
  ChatCompletionOptions,
  ChatMessage,
  ChatMessageContent,
  OpenRouterMessageContent,
  OpenRouterResponse,
  OpenRouterToolCall,
  TextContentPart,
} from './types.ts';

interface HttpError extends Error {
  status?: number;
  details?: string;
}

const OPENROUTER_PROXY_CHAT_COMPLETIONS_PATH = '/api/openrouter/chat/completions';
const ARTIFACT_SETTINGS_PATH = '/api/openrouter/artifact-settings';

const getOpenRouterProxyUrl = (): string =>
  `${getBackendUrl()}${OPENROUTER_PROXY_CHAT_COMPLETIONS_PATH}`;

export const getArtifactVisualReviewSettings = async (): Promise<{
  enabled: boolean;
  maxRounds: number;
}> => {
  try {
    const response = await fetchWithSupabaseAuth(`${getBackendUrl()}${ARTIFACT_SETTINGS_PATH}`);
    if (!response.ok) {
      return { enabled: true, maxRounds: 1 };
    }
    const payload = (await response.json()) as {
      visualReviewEnabled?: unknown;
      visualReviewMaxRounds?: unknown;
    };
    const maxRounds = Number(payload.visualReviewMaxRounds);
    return {
      enabled: payload.visualReviewEnabled !== false,
      maxRounds: Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 4 ? maxRounds : 1,
    };
  } catch {
    return { enabled: true, maxRounds: 1 };
  }
};

const getHeaders = (
  modelSlot: ChatCompletionOptions['modelSlot'],
  allowTextOnlyImageFallback = false
) => ({
  'Content-Type': 'application/json',
  'X-Nous-Model-Slot': modelSlot,
  ...(allowTextOnlyImageFallback ? { 'X-Nous-Allow-Text-Only-Image-Fallback': 'true' } : {}),
});

const createPayloadTooLargeError = (details: string): HttpError => {
  const error = new Error(OPENROUTER_PAYLOAD_TOO_LARGE_MESSAGE) as HttpError;
  error.status = 413;
  error.details = details;
  console.warn('[Nous] OpenRouter payload skipped before proxy request', {
    details,
  });
  return error;
};

const serializeRequestBody = (body: Record<string, unknown>): string => {
  const serializedBody = JSON.stringify(body);
  const payloadBytes = measureUtf8Bytes(serializedBody);

  if (payloadBytes > OPENROUTER_SAFE_JSON_BODY_BYTES) {
    throw createPayloadTooLargeError(
      `payload_bytes=${payloadBytes};safe_limit_bytes=${OPENROUTER_SAFE_JSON_BODY_BYTES}`
    );
  }

  return serializedBody;
};

const extractTextContent = (content: OpenRouterMessageContent | undefined): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (!content) {
    return '';
  }

  return content
    .filter(
      (part): part is TextContentPart => part.type === 'text' && typeof part.text === 'string'
    )
    .map(part => part.text)
    .join('\n');
};

interface NormalizedUrlCitation {
  content?: string;
  title?: string;
  url: string;
}

const collectUrlCitations = (
  target: Map<string, NormalizedUrlCitation>,
  annotations: ChatAnnotation[] | undefined
): void => {
  for (const annotation of annotations || []) {
    if (annotation.type !== 'url_citation') continue;
    const citation = annotation.url_citation;
    try {
      const url = new URL(citation.url);
      if (!['http:', 'https:'].includes(url.protocol) || target.has(url.href)) continue;
      target.set(url.href, {
        url: url.href,
        ...(citation.title?.trim() ? { title: citation.title.trim().slice(0, 300) } : {}),
        ...(citation.content?.trim() ? { content: citation.content.trim().slice(0, 2_000) } : {}),
      });
    } catch {
      // Ignore malformed external citation URLs.
    }
  }
};

const appendUrlCitationAppendix = (
  content: string,
  citations: Map<string, NormalizedUrlCitation>,
  enabled: boolean | undefined
): string => {
  if (!enabled || citations.size === 0) return content;
  const sources = [...citations.values()].map(citation => {
    const excerpt = citation.content ? `\n  Estratto: ${citation.content}` : '';
    return `- ${citation.title || citation.url}: ${citation.url}${excerpt}`;
  });
  return `${content}\n\nFONTI WEB RESTITUITE DAL PROVIDER:\n${sources.join('\n')}`;
};

const logWebSearchUsage = (
  options: ChatCompletionOptions,
  usage: OpenRouterResponse['usage'] | undefined
): void => {
  const requestCount = usage?.server_tool_use?.web_search_requests;
  if (!Number.isFinite(requestCount) || requestCount === undefined) return;
  console.info('[Nous][Research] OpenRouter web search usage', {
    modelSlot: options.modelSlot,
    requests: requestCount,
  });
};

const appendReadableReasoningValue = (
  values: string[],
  seenValues: Set<string>,
  value: unknown
) => {
  if (typeof value !== 'string') {
    return;
  }

  const normalizedValue = value.trim();
  if (!normalizedValue || normalizedValue.length > 12000 || seenValues.has(normalizedValue)) {
    return;
  }

  seenValues.add(normalizedValue);
  values.push(value);
};

const extractReasoningText = (value: unknown): string => {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const values: string[] = [];
  const seenValues = new Set<string>();
  appendReadableReasoningValue(values, seenValues, record.reasoning);
  appendReadableReasoningValue(values, seenValues, record.text);
  appendReadableReasoningValue(values, seenValues, record.summary);

  const reasoningDetails = record.reasoning_details;
  if (Array.isArray(reasoningDetails)) {
    for (const detail of reasoningDetails) {
      if (!detail || typeof detail !== 'object') {
        continue;
      }

      const detailRecord = detail as Record<string, unknown>;
      appendReadableReasoningValue(values, seenValues, detailRecord.text);
      appendReadableReasoningValue(values, seenValues, detailRecord.summary);
      appendReadableReasoningValue(values, seenValues, detailRecord.content);
    }
  }

  return values.join('\n\n');
};

const extractDeltaContent = (content: ChatMessageContent | undefined): string =>
  extractTextContent(content);

const appendReasoningChunk = (currentReasoning: string, nextChunk: string): string => {
  if (!nextChunk) {
    return currentReasoning;
  }

  if (!currentReasoning) {
    return nextChunk;
  }

  if (nextChunk.startsWith(currentReasoning)) {
    return nextChunk;
  }

  if (currentReasoning.endsWith(nextChunk)) {
    return currentReasoning;
  }

  const currentTail = currentReasoning.trimEnd();
  const nextHead = nextChunk.trimStart();
  const shouldInsertParagraphBreak =
    currentTail.length > 0 &&
    nextHead.length > 0 &&
    /[.!?;:]$/.test(currentTail) &&
    /^(?:#{1,6}\s|[-*+]\s|\d+\.\s|[A-ZÀ-ÖØ-Ý])/.test(nextHead);

  return shouldInsertParagraphBreak
    ? `${currentReasoning}\n\n${nextChunk}`
    : `${currentReasoning}${nextChunk}`;
};

const createHttpError = async (response: Response): Promise<HttpError> => {
  const details = await response.text();
  const message =
    response.status === 413
      ? OPENROUTER_PAYLOAD_TOO_LARGE_MESSAGE
      : 'Il servizio AI non ha completato la richiesta. Riprova tra poco.';
  const error = new Error(message) as HttpError;
  error.status = response.status;
  error.details = details || response.statusText;
  console.warn('[Nous] OpenRouter request failed', {
    status: response.status,
    details: error.details,
  });
  return error;
};

export const callOpenRouterRaw = async (
  options: ChatCompletionOptions
): Promise<OpenRouterResponse> => {
  const selectedModel = resolveOpenRouterModel(
    options.model,
    options.modelSlot,
    !options.disableModelOverride
  );
  const body = serializeRequestBody({
    model: selectedModel,
    messages: options.messages,
    reasoning: options.reasoning,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? MAX_OUTPUT_TOKENS,
    response_format: options.response_format,
    transforms: options.transforms,
    tools: options.tools,
    plugins: options.plugins,
  });
  const response = await fetchWithSupabaseAuth(getOpenRouterProxyUrl(), {
    method: 'POST',
    headers: getHeaders(options.modelSlot, options.allowTextOnlyImageFallback),
    body,
    signal: options.signal,
  });

  if (!response.ok) {
    throw await createHttpError(response);
  }

  return (await response.json()) as OpenRouterResponse;
};

const callOpenRouterStreaming = async (options: ChatCompletionOptions): Promise<string> => {
  const selectedModel = resolveOpenRouterModel(
    options.model,
    options.modelSlot,
    !options.disableModelOverride
  );
  const body = serializeRequestBody({
    model: selectedModel,
    messages: options.messages,
    reasoning: options.reasoning,
    stream: true,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? MAX_OUTPUT_TOKENS,
    response_format: options.response_format,
    transforms: options.transforms,
    tools: options.tools,
    plugins: options.plugins,
    stream_options: { include_usage: true },
  });
  const response = await fetchWithSupabaseAuth(getOpenRouterProxyUrl(), {
    method: 'POST',
    headers: getHeaders(options.modelSlot, options.allowTextOnlyImageFallback),
    body,
    signal: options.signal,
  });

  if (!response.ok) {
    throw await createHttpError(response);
  }

  if (!response.body) {
    return '';
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let bufferedSse = '';
  let content = '';
  let reasoning = '';
  let receivedAnyDelta = false;
  let streamError: HttpError | null = null;
  const urlCitations = new Map<string, NormalizedUrlCitation>();

  const buildStreamError = (payload: Record<string, unknown>, rawDetails: string): HttpError => {
    const errorRecord =
      payload.error && typeof payload.error === 'object'
        ? (payload.error as Record<string, unknown>)
        : null;
    const message =
      (errorRecord && typeof errorRecord.message === 'string' && errorRecord.message) ||
      (typeof payload.message === 'string' && payload.message) ||
      'Il servizio AI ha interrotto la generazione. Riprova tra poco.';
    const status =
      (errorRecord && typeof errorRecord.code === 'number' && errorRecord.code) ||
      (typeof payload.code === 'number' && payload.code) ||
      0;
    const error = new Error(message) as HttpError;
    error.status = status;
    error.details = rawDetails;
    return error;
  };

  const handleSseLine = (line: string) => {
    if (!line.startsWith('data:')) {
      return;
    }

    const payload = line.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') {
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch (parseError) {
      console.warn('[Nous] OpenRouter stream: skipping non-JSON SSE payload', {
        payload: payload.slice(0, 200),
        error: parseError,
      });
      return;
    }

    if (parsed.error) {
      streamError = buildStreamError(parsed, payload);
      console.warn('[Nous] OpenRouter stream returned error frame', {
        status: streamError.status,
        details: streamError.details,
      });
      return;
    }

    const choices = parsed.choices as
      | Array<{
          delta?: {
            annotations?: ChatAnnotation[];
            content?: ChatMessageContent;
            reasoning?: string;
            reasoning_details?: unknown[];
          };
          finish_reason?: string | null;
          message?: { annotations?: ChatAnnotation[] };
        }>
      | undefined;
    const choice = choices?.[0];
    const delta = choice?.delta;
    collectUrlCitations(urlCitations, delta?.annotations || choice?.message?.annotations);
    logWebSearchUsage(options, parsed.usage as OpenRouterResponse['usage'] | undefined);
    if (!delta) {
      return;
    }

    receivedAnyDelta = true;
    content += extractDeltaContent(delta.content);
    const reasoningChunk = extractReasoningText(delta);
    if (!reasoningChunk) {
      if (!reasoning) {
        options.onReasoningUpdate?.(content);
      }
      return;
    }

    reasoning = appendReasoningChunk(reasoning, reasoningChunk);
    options.onReasoningUpdate?.(reasoning);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    bufferedSse += decoder.decode(value, { stream: true });
    const lines = bufferedSse.split(/\r?\n/);
    bufferedSse = lines.pop() || '';
    for (const line of lines) {
      handleSseLine(line);
    }
  }

  const remaining = `${bufferedSse}${decoder.decode()}`;
  for (const line of remaining.split(/\r?\n/)) {
    handleSseLine(line);
  }

  if (streamError) {
    throw streamError;
  }

  if (!receivedAnyDelta && !content) {
    const error = new Error(
      'Il servizio AI non ha restituito alcun contenuto. Riprova tra poco.'
    ) as HttpError;
    error.status = 0;
    error.details = 'empty_stream';
    console.warn('[Nous] OpenRouter stream closed without any delta chunk');
    throw error;
  }

  return appendUrlCitationAppendix(content, urlCitations, options.includeUrlCitationsInText);
};

export const callOpenRouter = async (options: ChatCompletionOptions): Promise<string> => {
  if (options.onReasoningUpdate) {
    return callOpenRouterStreaming(options);
  }

  const data = await callOpenRouterRaw(options);
  logWebSearchUsage(options, data.usage);
  const urlCitations = new Map<string, NormalizedUrlCitation>();
  collectUrlCitations(urlCitations, data.choices?.[0]?.message?.annotations);
  return appendUrlCitationAppendix(
    extractTextContent(data.choices?.[0]?.message?.content),
    urlCitations,
    options.includeUrlCitationsInText
  );
};

const MAX_LOCAL_TOOL_ROUNDS = 12;
export const MAX_LOCAL_TOOL_CONTEXT_BYTES = 8 * 1024 * 1024;
const TOOL_CONTEXT_LIMIT_MESSAGE =
  'Il modello ha superato il limite cumulativo di consultazione della sorgente.';

export const callOpenRouterWithTools = async (
  options: ChatCompletionOptions,
  runTool: (toolCall: OpenRouterToolCall) => Promise<unknown>
): Promise<string> => {
  const messages: ChatMessage[] = [...options.messages];
  const textEncoder = new TextEncoder();
  let toolContextBytes = 0;

  for (let round = 0; round < MAX_LOCAL_TOOL_ROUNDS; round += 1) {
    const response = await callOpenRouterRaw({
      ...options,
      messages,
      onReasoningUpdate: undefined,
    });
    const message = response.choices?.[0]?.message;
    const reasoning = extractReasoningText(message);
    if (reasoning) {
      options.onReasoningUpdate?.(reasoning);
    }

    const toolCalls = message?.tool_calls || [];
    if (toolCalls.length === 0) {
      return extractTextContent(message?.content);
    }

    messages.push({
      role: 'assistant',
      content: message?.content || '',
      tool_calls: toolCalls,
    });
    for (const toolCall of toolCalls) {
      if (!toolCall.id || !toolCall.function.name) {
        throw new Error('Il modello ha restituito una chiamata tool non valida.');
      }
      const toolResult = JSON.stringify(await runTool(toolCall)) ?? 'null';
      toolContextBytes += textEncoder.encode(toolResult).byteLength;
      if (toolContextBytes > MAX_LOCAL_TOOL_CONTEXT_BYTES) {
        throw new Error(TOOL_CONTEXT_LIMIT_MESSAGE);
      }
      messages.push({
        role: 'tool',
        content: toolResult,
        tool_call_id: toolCall.id,
      });
    }
  }

  throw new Error('Il modello ha superato il limite di consultazione della sorgente.');
};
