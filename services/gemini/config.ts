import { SYSTEM_INSTRUCTION_PLANNER, SYSTEM_INSTRUCTION_TEACHER } from '../../constants.ts';
import type { OpenRouterModelSlot } from '../../types.ts';
import { readUiPreferences } from '../uiPreferencesStorage.ts';

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || '32000', 10);

export const MODEL_FLASH = process.env.MODEL_FLASH || 'openai/gpt-5.4-nano';
export const MODEL_REASONING = process.env.MODEL_REASONING || 'openai/gpt-5.4-mini';
export const MODEL_ASSESSMENT = process.env.MODEL_ASSESSMENT || 'mistralai/mistral-small-2603';
export const MODEL_CONTEXT = process.env.MODEL_CONTEXT || 'openai/gpt-5.4-nano';

export const resolveOpenRouterModel = (
  fallbackModel: string,
  slot: OpenRouterModelSlot = 'lesson'
): string => {
  if (typeof window === 'undefined') {
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

export const DEFAULT_BACKEND_PORT = 3001;
export const DEFAULT_BACKEND_URL = `http://localhost:${DEFAULT_BACKEND_PORT}`;

const getSameHostBackendUrl = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const { hostname, protocol } = window.location;
  if (!hostname || protocol === 'file:') {
    return null;
  }

  return `${protocol}//${hostname}:${DEFAULT_BACKEND_PORT}`;
};

export const getBackendUrl = (): string => {
  return getSameHostBackendUrl() || DEFAULT_BACKEND_URL;
};

export const plannerInstruction = SYSTEM_INSTRUCTION_PLANNER;
export const teacherInstruction = SYSTEM_INSTRUCTION_TEACHER;
