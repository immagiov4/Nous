import { DEFAULT_VOICE_OPTIONS, normalizeVoiceProfileId, type VoiceOption } from '../voiceProfile.ts';
import { getErrorMessage, normalizeTtsConnectionError, type VoiceProfileId } from './shared.ts';
import { requestSpeechAudio, requestTtsStatus, requestTtsVoices } from './ttsClient.ts';

export const generateSpeech = async (text: string, voice: VoiceProfileId): Promise<ArrayBuffer> => {
  try {
    return await requestSpeechAudio({
      text,
      voice,
      speed: 1,
    });
  } catch (error) {
    throw normalizeTtsConnectionError(error);
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
    return DEFAULT_VOICE_OPTIONS;
  }
};
