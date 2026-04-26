import type { VoiceProfileId } from '../../types.ts';

export interface VoiceOption {
  id: VoiceProfileId;
  label: string;
  language: string;
}

export const DEFAULT_TTS_MODEL = 'openai/gpt-4o-mini-tts-2025-12-15';
export const DEFAULT_TTS_VOICE = 'coral';

export const DEFAULT_VOICE_OPTIONS: VoiceOption[] = [
  { id: 'coral', label: 'Coral', language: 'it-IT' },
  { id: 'alloy', label: 'Alloy', language: 'it-IT' },
  { id: 'ash', label: 'Ash', language: 'it-IT' },
  { id: 'ballad', label: 'Ballad', language: 'it-IT' },
  { id: 'cedar', label: 'Cedar', language: 'it-IT' },
  { id: 'echo', label: 'Echo', language: 'it-IT' },
  { id: 'fable', label: 'Fable', language: 'it-IT' },
  { id: 'marin', label: 'Marin', language: 'it-IT' },
  { id: 'nova', label: 'Nova', language: 'it-IT' },
  { id: 'onyx', label: 'Onyx', language: 'it-IT' },
  { id: 'sage', label: 'Sage', language: 'it-IT' },
  { id: 'shimmer', label: 'Shimmer', language: 'it-IT' },
  { id: 'verse', label: 'Verse', language: 'it-IT' },
];

export const normalizeVoiceProfileId = (value: string | null | undefined): VoiceProfileId => {
  const trimmedVoice = value?.trim();
  return DEFAULT_VOICE_OPTIONS.some(voice => voice.id === trimmedVoice)
    ? trimmedVoice
    : DEFAULT_TTS_VOICE;
};
