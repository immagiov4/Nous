// Reads backend chat configuration from the environment.
import './env.js';

const DEFAULT_CONTEXT_CHAT_MODEL = 'google/gemini-3.1-flash-lite';
export const CONTEXT_CHAT_MODEL = process.env.MODEL_CONTEXT || DEFAULT_CONTEXT_CHAT_MODEL;

export const requireOpenRouterApiKey = () => {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
  if (!openRouterApiKey) {
    throw new Error(
      'Missing OPENROUTER_API_KEY. Add it to apps/backend/.env.local or the project root .env.local.'
    );
  }

  return openRouterApiKey;
};
