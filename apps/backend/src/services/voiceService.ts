import type { VoiceProfile } from '../types/index.js';

import { ttsClient } from './ttsClient.js';

export interface VoiceSummary {
  id: string;
  language: string;
  mode: VoiceProfile['mode'];
  name: string;
}

export function listVoices(): {
  defaultVoice: string;
  voices: VoiceSummary[];
} {
  const profiles = ttsClient.getVoiceProfiles();
  const defaultProfile = ttsClient.getDefaultProfile();

  return {
    defaultVoice: defaultProfile.id,
    voices: profiles.map(profile => ({
      id: profile.id,
      language: profile.language,
      mode: profile.mode,
      name: profile.name,
    })),
  };
}

export function getVoiceDetails(voiceId: string): {
  voice: {
    id: string;
    language: string;
    mode: VoiceProfile['mode'];
    name: string;
    settings: VoiceProfile['modelSettings'];
  };
} | null {
  const profile = ttsClient.getVoiceProfile(voiceId);

  if (!profile) {
    return null;
  }

  return {
    voice: {
      id: profile.id,
      language: profile.language,
      mode: profile.mode,
      name: profile.name,
      settings: profile.modelSettings,
    },
  };
}
