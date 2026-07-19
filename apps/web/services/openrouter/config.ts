import type { OpenRouterModelSlot } from '../../types.ts';
import { getNousRuntimeConfig } from '../runtimeConfig.ts';
import { SYSTEM_INSTRUCTION_PLANNER, SYSTEM_INSTRUCTION_TEACHER } from './prompts.ts';
import type { OpenRouterReasoningOptions } from './types.ts';

const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export const MAX_OUTPUT_TOKENS = Number.parseInt(
  process.env.MAX_OUTPUT_TOKENS || String(DEFAULT_MAX_OUTPUT_TOKENS),
  10
);
const DEFAULT_CONTEXT_MODEL = 'google/gemini-3.1-flash-lite';

export const MODEL_FLASH = process.env.MODEL_FLASH || 'openai/gpt-5.4-nano';
export const MODEL_REASONING = process.env.MODEL_REASONING || 'openai/gpt-5.4-mini';
export const MODEL_CONTEXT = process.env.MODEL_CONTEXT || DEFAULT_CONTEXT_MODEL;
export const MODEL_ASSESSMENT = process.env.MODEL_ASSESSMENT || MODEL_CONTEXT;
export const MODEL_RESEARCH_PLANNER =
  process.env.MODEL_RESEARCH_PLANNER || 'perplexity/sonar-pro-search';
export const MODEL_RESEARCH_DOSSIER = process.env.MODEL_RESEARCH_DOSSIER || MODEL_RESEARCH_PLANNER;
export const MODEL_PDF_IMAGE_CAPTION =
  process.env.MODEL_PDF_IMAGE_CAPTION || 'nvidia/nemotron-nano-12b-v2-vl';
export const MODEL_VISUAL_PLANNER = process.env.MODEL_VISUAL_PLANNER || MODEL_FLASH;
export const MODEL_VISUAL_RENDERER = process.env.MODEL_VISUAL_RENDERER || MODEL_REASONING;

export const LOW_REASONING_CONFIG: OpenRouterReasoningOptions = {
  effort: 'low',
  exclude: true,
};

export const MEDIUM_REASONING_CONFIG: OpenRouterReasoningOptions = {
  effort: 'medium',
  exclude: false,
};

export const OPENROUTER_WEB_SEARCH_TOOL = { type: 'openrouter:web_search' } as const;

export const resolveOpenRouterModel = (
  fallbackModel: string,
  _slot: OpenRouterModelSlot = 'lesson',
  _allowFrontendOverride = true
): string => {
  return fallbackModel;
};

const FALLBACK_BACKEND_HOST = '127.0.0.1';
const FALLBACK_BACKEND_PORT = 3301;

// Frontend config normalizes Vite build-time env values. Keep this local to
// avoid coupling browser code to the backend's Node config loader.
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

const DEFAULT_BACKEND_HOST = normalizeHost(
  import.meta.env.VITE_BACKEND_HOST,
  FALLBACK_BACKEND_HOST
);
const DEFAULT_BACKEND_PORT = normalizePort(
  import.meta.env.VITE_BACKEND_PORT,
  FALLBACK_BACKEND_PORT
);
const DEFAULT_BACKEND_URL = `http://${DEFAULT_BACKEND_HOST}:${DEFAULT_BACKEND_PORT}`;

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
  return (
    getNousRuntimeConfig().backendUrl?.replace(/\/$/, '') ||
    getSameHostBackendUrl() ||
    DEFAULT_BACKEND_URL
  );
};

export const plannerInstruction = SYSTEM_INSTRUCTION_PLANNER;
export const teacherInstruction = SYSTEM_INSTRUCTION_TEACHER;
