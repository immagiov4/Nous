import {
  MAX_OUTPUT_TOKENS,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  resolveOpenRouterModel,
} from './config.ts';
import type {
  ChatCompletionOptions,
  OpenRouterMessageContent,
  OpenRouterResponse,
  TextContentPart,
} from './types.ts';

interface HttpError extends Error {
  status?: number;
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

const createHttpError = async (response: Response): Promise<HttpError> => {
  const details = await response.text();
  const error = new Error(
    `OpenRouter API error: ${response.status} - ${details || response.statusText}`
  ) as HttpError;
  error.status = response.status;
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

export const callOpenRouter = async (options: ChatCompletionOptions): Promise<string> => {
  const data = await callOpenRouterRaw(options);
  return extractTextContent(data.choices?.[0]?.message?.content);
};
