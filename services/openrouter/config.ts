import serverConfig from '../../server.config.json';

import type { OpenRouterModelSlot } from '../../types.ts';
import { readUiPreferences } from '../preferences/uiPreferencesStorage.ts';
import { SYSTEM_INSTRUCTION_PLANNER, SYSTEM_INSTRUCTION_TEACHER } from './prompts.ts';
import type { OpenRouterReasoningOptions } from './types.ts';

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || '32000', 10);
export const DEFAULT_CONTEXT_MODEL = 'google/gemini-3.1-flash-lite-preview';

export const MODEL_FLASH = process.env.MODEL_FLASH || 'openai/gpt-5.4-nano';
export const MODEL_REASONING = process.env.MODEL_REASONING || 'openai/gpt-5.4-mini';
export const MODEL_ASSESSMENT = process.env.MODEL_ASSESSMENT || 'mistralai/mistral-small-2603';
export const MODEL_CONTEXT = process.env.MODEL_CONTEXT || DEFAULT_CONTEXT_MODEL;
export const MODEL_PDF_IMAGE_CAPTION =
  process.env.MODEL_PDF_IMAGE_CAPTION || 'nvidia/nemotron-nano-12b-v2-vl';

export const HIGH_REASONING_CONFIG: OpenRouterReasoningOptions = {
  effort: 'high',
  exclude: false,
};

export const MEDIUM_REASONING_CONFIG: OpenRouterReasoningOptions = {
  effort: 'medium',
  exclude: false,
};

export const resolveOpenRouterModel = (
  fallbackModel: string,
  slot: OpenRouterModelSlot = 'lesson',
  allowUiOverride = true
): string => {
  if (typeof window === 'undefined' || !allowUiOverride) {
    return fallbackModel;
  }

  const preferences = readUiPreferences(window.localStorage);
  const preferredModel =
    slot === 'assessment'
      ? preferences?.preferredAssessmentModel?.trim()
      : slot === 'context'
        ? preferences?.preferredContextModel?.trim()
        : preferences?.preferredLessonModel?.trim();

  return preferredModel || fallbackModel;
};

const FALLBACK_BACKEND_HOST = '127.0.0.1';
const FALLBACK_BACKEND_PORT = 3301;

const normalizeHost = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const normalizePort = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';

const isWildcardHost = (host: string): boolean => host === '0.0.0.0' || host === '::';

export const DEFAULT_BACKEND_HOST = normalizeHost(
  import.meta.env.VITE_BACKEND_HOST,
  serverConfig.backendHost || FALLBACK_BACKEND_HOST
);
export const DEFAULT_BACKEND_PORT = normalizePort(
  import.meta.env.VITE_BACKEND_PORT,
  serverConfig.backendPort || FALLBACK_BACKEND_PORT
);
export const DEFAULT_BACKEND_URL = `http://${DEFAULT_BACKEND_HOST}:${DEFAULT_BACKEND_PORT}`;

const getSameHostBackendUrl = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const { hostname, protocol } = window.location;
  if (!hostname || protocol === 'file:') {
    return null;
  }

  if (!isWildcardHost(DEFAULT_BACKEND_HOST) && !isLoopbackHost(DEFAULT_BACKEND_HOST)) {
    return null;
  }

  return `${protocol}//${hostname}:${DEFAULT_BACKEND_PORT}`;
};

export const getBackendUrl = (): string => {
  return getSameHostBackendUrl() || DEFAULT_BACKEND_URL;
};

export const plannerInstruction = SYSTEM_INSTRUCTION_PLANNER;
export const teacherInstruction = SYSTEM_INSTRUCTION_TEACHER;
