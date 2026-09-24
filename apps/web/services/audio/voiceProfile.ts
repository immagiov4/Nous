import type { VoiceProfileId } from '../../types.ts';

export interface VoiceOption {
  id: VoiceProfileId;
  label: string;
  language: string;
}

export const DEFAULT_TTS_MODEL = 'google/gemini-3.8-flash-tts';
export const DEFAULT_TTS_VOICE = 'Zephyr';

const DEFAULT_TTS_VOICE_IDS: VoiceProfileId[] = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];

const DEFAULT_TTS_VOICE_SET = new Set(DEFAULT_TTS_VOICE_IDS);

const formatVoiceLabel = (voiceId: VoiceProfileId): string =>
  voiceId.charAt(0).toUpperCase() + voiceId.slice(1);

export const DEFAULT_VOICE_OPTIONS: VoiceOption[] = DEFAULT_TTS_VOICE_IDS.map(id => ({
  id,
  label: formatVoiceLabel(id),
  language: 'it-IT',
}));

export const normalizeVoiceProfileId = (value: string | null | undefined): VoiceProfileId => {
  const trimmedVoice = value?.trim();
  return trimmedVoice && DEFAULT_TTS_VOICE_SET.has(trimmedVoice) ? trimmedVoice : DEFAULT_TTS_VOICE;
};
