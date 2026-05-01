import './env.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const DEFAULT_CONTEXT_CHAT_MODEL = 'google/gemini-3.1-flash-lite-preview';
export const CONTEXT_CHAT_MODEL = process.env.MODEL_CONTEXT || DEFAULT_CONTEXT_CHAT_MODEL;

export const requireOpenRouterApiKey = () => {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      'Missing OPENROUTER_API_KEY. Add it to apps/backend/.env.local or the project root .env.local.'
    );
  }

  return OPENROUTER_API_KEY;
};
