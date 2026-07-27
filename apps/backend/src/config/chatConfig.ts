// Reads backend chat configuration from the environment.
import './env.js';

const DEFAULT_CONTEXT_CHAT_MODEL = 'google/gemini-3.1-flash-lite';
export const CONTEXT_CHAT_MODEL = process.env.MODEL_CONTEXT || DEFAULT_CONTEXT_CHAT_MODEL;

export const requireOpenRouterApiKey = () => {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
  if (!openRouterApiKey) {
    console.error('[AI Config] OPENROUTER_API_KEY is missing.');
    throw new Error('Servizio AI non configurato.');
  }

  return openRouterApiKey;
};

export const requireOpenAiApiKey = () => {
  const openAiApiKey = process.env.OPENAI_API_KEY || '';
  if (!openAiApiKey) {
    console.error('[AI Config] OPENAI_API_KEY is missing.');
    throw new Error('Servizio AI non configurato.');
  }

  return openAiApiKey;
};
