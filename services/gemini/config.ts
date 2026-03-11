import { SYSTEM_INSTRUCTION_PLANNER, SYSTEM_INSTRUCTION_TEACHER } from '../../constants';

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS || '32000', 10);

export const MODEL_FLASH = process.env.MODEL_FLASH || 'google/gemini-3-flash-preview';
export const MODEL_REASONING = process.env.MODEL_REASONING || 'google/gemini-3-flash-preview';

export const BACKEND_URL = 'http://localhost:3001';
export const plannerInstruction = SYSTEM_INSTRUCTION_PLANNER;
export const teacherInstruction = SYSTEM_INSTRUCTION_TEACHER;
