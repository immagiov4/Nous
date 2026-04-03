import type { VoiceProfileId } from '../../types.ts';

export interface VoiceOption {
  id: VoiceProfileId;
  label: string;
  language: string;
}

export const DEFAULT_VOICE_OPTIONS: VoiceOption[] = [
  { id: 'mario', label: 'Mario', language: 'it-IT' },
];

export const normalizeVoiceProfileId = (value: string | null | undefined): VoiceProfileId =>
  value === 'mario' ? value : 'mario';
