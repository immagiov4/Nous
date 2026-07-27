// Wraps the backend TTS client and model defaults.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireOpenRouterApiKey } from '../config/chatConfig.js';
import { loadOptionalJsonFile } from '../config/jsonFile.js';
import {
  DEFAULT_TTS_MODEL as CONFIG_DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE as CONFIG_DEFAULT_TTS_VOICE,
} from '../config/modelConfig.js';
import type {
  GeneratedSpeechAudio,
  TTSRequest,
  TtsModelSummary,
  VoiceProfile,
  VoiceProfilesConfig,
} from '../types/index.js';
import { isRecord } from '../utils/validation.js';
import {
  getOpenRouterJsonHeaders,
  OPENROUTER_API_BASE_URL,
  readOpenRouterErrorDetails,
} from './openRouterApi.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const DEFAULT_TTS_MODEL =
  process.env.MODEL_TTS || process.env.TTS_MODEL_NAME || CONFIG_DEFAULT_TTS_MODEL;
const DEFAULT_TTS_VOICE = process.env.TTS_VOICE || CONFIG_DEFAULT_TTS_VOICE;
const TTS_RESPONSE_FORMAT = 'mp3';

interface OpenRouterSpeechAttempt {
  model: string;
  speed?: number;
  text: string;
  voice: string;
}

class OpenRouterTtsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: string
  ) {
    super(message);
    this.name = 'OpenRouterTtsError';
  }
}

const DEFAULT_TTS_VOICE_IDS = ['Ara', 'Eve', 'Rex', 'Sal', 'Leo'] as const;

const VOICE_PROFILE_MODES = new Set(['openrouter_voice', 'voice_design']);

const DEFAULT_TTS_MODEL_SUMMARY: TtsModelSummary = {
  contextLength: 0,
  id: DEFAULT_TTS_MODEL,
  name: 'xAI: Grok Voice TTS 1.0',
  pricing: {
    completion: '0',
    prompt: '0.000015',
  },
  supportedParameters: ['response_format'],
  supportsVoiceCloning: false,
  voiceHelpLabel: 'Voci OpenRouter',
  voiceHelpUrl: 'https://openrouter.ai/x-ai/grok-voice-tts-1.0/api',
};

const formatVoiceName = (voiceId: string): string =>
  voiceId.charAt(0).toUpperCase() + voiceId.slice(1);

const createDefaultVoiceProfile = (voiceId: string): VoiceProfile => ({
  id: voiceId,
  name: formatVoiceName(voiceId),
  language: 'it-IT',
  mode: 'openrouter_voice',
  voiceDesignPrompt: voiceId,
  modelSettings: { temperature: 0.7, speed: 1.0 },
});

const getDefaultVoiceProfileIds = (): string[] =>
  DEFAULT_TTS_VOICE_IDS.includes(DEFAULT_TTS_VOICE as (typeof DEFAULT_TTS_VOICE_IDS)[number])
    ? [...DEFAULT_TTS_VOICE_IDS]
    : [DEFAULT_TTS_VOICE, ...DEFAULT_TTS_VOICE_IDS];

const createDefaultVoiceProfiles = (): VoiceProfilesConfig => ({
  profiles: getDefaultVoiceProfileIds().map(createDefaultVoiceProfile),
  defaultProfile: DEFAULT_TTS_VOICE,
});

const isVoiceProfile = (value: unknown): value is VoiceProfile => {
  if (!isRecord(value)) {
    return false;
  }

  const mode = typeof value.mode === 'string' ? value.mode : '';
  const modelSettings = value.modelSettings;

  return (
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.language === 'string' &&
    value.language.trim().length > 0 &&
    VOICE_PROFILE_MODES.has(mode) &&
    typeof value.voiceDesignPrompt === 'string' &&
    value.voiceDesignPrompt.trim().length > 0 &&
    isRecord(modelSettings) &&
    typeof modelSettings.temperature === 'number' &&
    typeof modelSettings.speed === 'number'
  );
};

const normalizeVoiceProfilesConfig = (value: unknown): VoiceProfilesConfig => {
  if (!isRecord(value) || !Array.isArray(value.profiles)) {
    throw new Error('voice-profiles.json deve contenere un array "profiles".');
  }

  const profiles = value.profiles.filter(isVoiceProfile);
  if (profiles.length === 0) {
    throw new Error('voice-profiles.json non contiene profili vocali validi.');
  }

  const requestedDefaultProfile =
    typeof value.defaultProfile === 'string' ? value.defaultProfile.trim() : '';
  const defaultProfile = profiles.some(profile => profile.id === requestedDefaultProfile)
    ? requestedDefaultProfile
    : profiles[0].id;

  if (defaultProfile !== requestedDefaultProfile) {
    console.warn(
      `[TTSClient] Profilo vocale predefinito "${requestedDefaultProfile}" non trovato; uso "${defaultProfile}".`
    );
  }

  return {
    profiles,
    defaultProfile,
  };
};

const normalizeOptionalText = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim();
  return trimmed || fallback;
};

class TTSClient {
  private voiceProfiles: VoiceProfilesConfig;

  constructor() {
    this.voiceProfiles = this.loadVoiceProfiles();
  }

  private loadVoiceProfiles(): VoiceProfilesConfig {
    const profilesPath = join(__dirname, '..', 'config', 'voice-profiles.json');
    const loadedProfiles = loadOptionalJsonFile<unknown>(profilesPath, 'voice-profiles.json');

    return loadedProfiles
      ? normalizeVoiceProfilesConfig(loadedProfiles)
      : createDefaultVoiceProfiles();
  }

  getVoiceProfiles(): VoiceProfile[] {
    return this.voiceProfiles.profiles;
  }

  getDefaultProfile(): VoiceProfile {
    const defaultId = this.voiceProfiles.defaultProfile;
    const defaultProfile = this.voiceProfiles.profiles.find(profile => profile.id === defaultId);
    if (!defaultProfile) {
      throw new Error(`Profilo vocale predefinito "${defaultId}" non disponibile.`);
    }

    return defaultProfile;
  }

  getVoiceProfile(id: string): VoiceProfile | undefined {
    return this.voiceProfiles.profiles.find(profile => profile.id === id);
  }

  private async requestSpeech(attempt: OpenRouterSpeechAttempt): Promise<GeneratedSpeechAudio> {
    const response = await fetch(`${OPENROUTER_API_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: getOpenRouterJsonHeaders(),
      body: JSON.stringify({
        model: attempt.model,
        input: attempt.text,
        voice: attempt.voice,
        response_format: TTS_RESPONSE_FORMAT,
        speed: attempt.speed,
      }),
    });

    if (!response.ok) {
      const details = await readOpenRouterErrorDetails(response);
      console.warn('[Nous] OpenRouter TTS request failed', {
        status: response.status,
        model: attempt.model,
        voice: attempt.voice,
        details,
      });
      throw new OpenRouterTtsError(
        'Il servizio TTS non ha completato la richiesta. Riprova tra poco.',
        response.status,
        details
      );
    }

    return {
      audioBuffer: await response.arrayBuffer(),
      contentType: response.headers.get('content-type') || 'audio/mpeg',
      generationId: response.headers.get('x-generation-id') || undefined,
    };
  }

  async generateSpeech(request: TTSRequest): Promise<GeneratedSpeechAudio> {
    const selectedProfile = request.voice ? this.getVoiceProfile(request.voice) : undefined;
    const voice = normalizeOptionalText(
      selectedProfile?.voiceDesignPrompt ?? request.voice,
      this.getDefaultProfile().voiceDesignPrompt || DEFAULT_TTS_VOICE
    );
    const normalizedVoice = normalizeOptionalText(voice, DEFAULT_TTS_VOICE);
    const model = normalizeOptionalText(request.model, DEFAULT_TTS_MODEL);

    console.log(
      `[TTSClient] Generating OpenRouter speech for ${request.text.length} chars with model: ${model}, voice: ${normalizedVoice}`
    );

    return this.requestSpeech({
      model,
      text: request.text,
      voice: normalizedVoice,
      speed: request.speed,
    });
  }

  async listModels(): Promise<TtsModelSummary[]> {
    return [DEFAULT_TTS_MODEL_SUMMARY];
  }

  async checkReady(): Promise<{ message: string; ready: boolean }> {
    try {
      requireOpenRouterApiKey();
      await this.listModels();
      return {
        ready: true,
        message: 'OpenRouter TTS pronto.',
      };
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : 'OpenRouter TTS non pronto.',
      };
    }
  }
}

export const ttsClient = new TTSClient();
