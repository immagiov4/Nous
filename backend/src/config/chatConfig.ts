import { resolve } from 'node:path';

import dotenv from 'dotenv';

const loadEnvFile = (relativePath: string) => {
  dotenv.config({
    path: resolve(process.cwd(), relativePath),
    override: false,
  });
};

loadEnvFile('.env.local');
loadEnvFile('.env');
loadEnvFile('../.env.local');
loadEnvFile('../.env');

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const CONTEXT_CHAT_MODEL =
  process.env.MODEL_CONTEXT || process.env.MODEL_FLASH || 'openai/gpt-5.4-nano';

export const requireOpenRouterApiKey = () => {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      'Missing OPENROUTER_API_KEY. Add it to backend/.env.local or the project root .env.local.'
    );
  }

  return OPENROUTER_API_KEY;
};
