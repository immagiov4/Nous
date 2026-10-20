import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE_OPTIONS,
  normalizeVoiceProfileId,
  type VoiceOption,
} from '../audio/voiceProfile.ts';
import { getErrorMessage, normalizeTtsConnectionError, type VoiceProfileId } from './shared.ts';
import {
  requestSpeechAudio,
  requestTtsModels,
  requestTtsStatus,
  requestTtsVoices,
  type SpeechAudioResponse,
} from './ttsClient.ts';
import type { TtsModelSummary } from './types.ts';

export const generateSpeech = async ({
  text,
  voice,
  model = DEFAULT_TTS_MODEL,
  block,
  target,
}: {
  text: string;
  voice: VoiceProfileId;
  model?: string;
  block?: LessonPlaybackBlock;
  target?: { projectId: string; sectionId: string };
}): Promise<SpeechAudioResponse> => {
  try {
    return await requestSpeechAudio({
      model,
      text,
      voice,
      speed: 1,
      ...(block ? { block } : {}),
      ...(target ? { target } : {}),
    });
  } catch (error) {
    throw normalizeTtsConnectionError(error);
  }
};

export const getTTSModels = async (): Promise<{
  defaultModel: string;
  models: TtsModelSummary[];
}> => {
  try {
    const payload = await requestTtsModels();
    return {
      defaultModel: payload.defaultModel || DEFAULT_TTS_MODEL,
      models: payload.models || [],
    };
  } catch {
    return {
      defaultModel: DEFAULT_TTS_MODEL,
      models: [],
    };
  }
};

export const checkTTSStatus = async (): Promise<{
  isRunning: boolean;
  isReady: boolean;
  error?: string;
}> => {
  try {
    const data = await requestTtsStatus();
    return {
      isRunning: Boolean(data.status?.isRunning),
      isReady: Boolean(data.status?.isReady),
      error: data.status?.lastError,
    };
  } catch (error) {
    return {
      isRunning: false,
      isReady: false,
      error: getErrorMessage(error),
    };
  }
};

export const getTTSVoices = async (): Promise<VoiceOption[]> => {
  try {
    const voices = await requestTtsVoices();
    return voices.map(voice => ({
      id: normalizeVoiceProfileId(voice.id),
      label: voice.name,
      language: voice.language,
    }));
  } catch {
    // intentional: fallback to default
    return DEFAULT_VOICE_OPTIONS;
  }
};
