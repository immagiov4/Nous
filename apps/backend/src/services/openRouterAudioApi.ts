import { requireOpenRouterApiKey } from '../config/chatConfig.js';
import { isRecord } from '../utils/validation.js';

export const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';

const OPENROUTER_APP_REFERER = process.env.OPENROUTER_APP_REFERER || 'http://localhost:5173';
const OPENROUTER_APP_TITLE = 'Nous Reader';

export const getOpenRouterJsonHeaders = () => ({
  Authorization: `Bearer ${requireOpenRouterApiKey()}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': OPENROUTER_APP_REFERER,
  'X-OpenRouter-Title': OPENROUTER_APP_TITLE,
});

export const readOpenRouterErrorDetails = async (response: Response): Promise<string> => {
  const responseText = await response.text();
  if (!responseText) {
    return response.statusText || 'Unknown OpenRouter error';
  }

  try {
    const payload: unknown = JSON.parse(responseText);
    if (!isRecord(payload)) {
      return responseText;
    }

    const nestedError = isRecord(payload.error) ? payload.error : undefined;
    if (typeof nestedError?.message === 'string') {
      return nestedError.message;
    }

    return typeof payload.message === 'string' ? payload.message : responseText;
  } catch {
    // OpenRouter error bodies are not guaranteed to be JSON.
    return responseText;
  }
};
