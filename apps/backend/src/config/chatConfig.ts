import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backendRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(backendRoot, '..', '..');

const loadEnvFile = (absolutePath: string) => {
  dotenv.config({
    path: absolutePath,
    override: false,
  });
};

loadEnvFile(resolve(backendRoot, '.env.local'));
loadEnvFile(resolve(backendRoot, '.env'));
loadEnvFile(resolve(repoRoot, '.env.local'));
loadEnvFile(resolve(repoRoot, '.env'));

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const DEFAULT_CONTEXT_CHAT_MODEL = 'google/gemini-3.1-flash-lite-preview';
export const CONTEXT_CHAT_MODEL = process.env.MODEL_CONTEXT || DEFAULT_CONTEXT_CHAT_MODEL;

export const requireOpenRouterApiKey = () => {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      'Missing OPENROUTER_API_KEY. Add it to apps/backend/.env.local or the project root .env.local.'
    );
  }

  return OPENROUTER_API_KEY;
};
