// fallow-ignore-file unused-files
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from '../services/audio/voiceProfile.ts';
import { MODEL_ASSESSMENT, MODEL_CONTEXT, MODEL_REASONING } from '../services/openrouter/index.ts';
import type { OpenRouterModelDefaults } from '../types.ts';

// fallow-ignore-next-line unused-exports — used by App.tsx
export const defaultModelConfig: OpenRouterModelDefaults = {
  lessonModel: MODEL_REASONING,
  assessmentModel: MODEL_ASSESSMENT,
  contextModel: MODEL_CONTEXT,
  ttsModel: DEFAULT_TTS_MODEL,
  ttsVoice: DEFAULT_TTS_VOICE,
};
