import {
  MAX_OUTPUT_TOKENS,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  resolveOpenRouterModel,
} from './config.ts';
import type {
  ChatCompletionOptions,
  ChatMessageContent,
  OpenRouterMessageContent,
  OpenRouterResponse,
  TextContentPart,
} from './types.ts';

interface HttpError extends Error {
  status?: number;
  details?: string;
}

const getHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${OPENROUTER_API_KEY}`,
  'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
  'X-Title': 'Nous Reader',
});

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
  const error = new Error(
    'Il servizio AI non ha completato la richiesta. Riprova tra poco.'
  ) as HttpError;
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
  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model: selectedModel,
      messages: options.messages,
      reasoning: options.reasoning,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? MAX_OUTPUT_TOKENS,
      response_format: options.response_format,
      tools: options.tools,
      plugins: options.plugins,
    }),
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
  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model: selectedModel,
      messages: options.messages,
      reasoning: options.reasoning,
      stream: true,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? MAX_OUTPUT_TOKENS,
      response_format: options.response_format,
      tools: options.tools,
      plugins: options.plugins,
    }),
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

  const handleSseLine = (line: string) => {
    if (!line.startsWith('data:')) {
      return;
    }

    const payload = line.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') {
      return;
    }

    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        delta?: {
          content?: ChatMessageContent;
          reasoning?: string;
          reasoning_details?: unknown[];
        };
      }>;
    };
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) {
      return;
    }

    content += extractDeltaContent(delta.content);
    const reasoningChunk = extractReasoningText(delta);
    if (!reasoningChunk) {
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

  return content;
};

export const callOpenRouter = async (options: ChatCompletionOptions): Promise<string> => {
  if (options.onReasoningUpdate) {
    return callOpenRouterStreaming(options);
  }

  const data = await callOpenRouterRaw(options);
  return extractTextContent(data.choices?.[0]?.message?.content);
};
