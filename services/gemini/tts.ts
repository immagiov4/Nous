import { getErrorMessage, normalizeTtsConnectionError, type VoiceName } from './shared';
import { requestSpeechAudio, requestTtsStatus, requestTtsVoices } from './ttsClient';

const voiceMapping: Record<VoiceName, string> = {
  Kore: 'mario',
  Fenrir: 'mario',
  Puck: 'mario',
  Zephyr: 'mario',
  Charon: 'mario',
  Marco: 'mario',
  Giulia: 'mario',
};

export const generateSpeech = async (text: string, voice: VoiceName): Promise<ArrayBuffer> => {
  try {
    return await requestSpeechAudio({
      text,
      voice: voiceMapping[voice],
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

export const getTTSVoices = async (): Promise<Array<{ id: string; name: string; language: string }>> => {
  try {
    return await requestTtsVoices();
  } catch {
    return [];
  }
};
