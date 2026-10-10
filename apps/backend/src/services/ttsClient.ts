// Wraps the backend TTS client and model defaults.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIMEType } from 'node:util';
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

const DEFAULT_TTS_VOICE_IDS = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'] as const;
const GROK_TTS_MODEL = 'x-ai/grok-voice-tts-1.0';
const GROK_TTS_VOICES = new Set(['ara', 'eve', 'rex', 'sal', 'leo']);

// Gemini TTS models verified to share the default voices and PCM output.
const GEMINI_TTS_MODELS = new Set([
  'google/gemini-3.8-flash-tts',
  'google/gemini-3.8-flash-lite-tts',
]);
const isGeminiTtsModel = (model: string): boolean => GEMINI_TTS_MODELS.has(model);

// Normalize voices crossing the rollout boundary; preserve provider-specific custom voices.
const normalizeModelVoice = (model: string, voice: string): string => {
  const lowerVoice = voice.toLowerCase();
  if (isGeminiTtsModel(model) && (GROK_TTS_VOICES.has(lowerVoice) || lowerVoice === 'coral')) {
    return CONFIG_DEFAULT_TTS_VOICE;
  }
  if (
    model === GROK_TTS_MODEL &&
    (DEFAULT_TTS_VOICE_IDS.some(id => id.toLowerCase() === lowerVoice) || lowerVoice === 'coral')
  ) {
    return 'Ara';
  }
  return voice;
};

const VOICE_PROFILE_MODES = new Set(['openrouter_voice', 'voice_design']);

const DEFAULT_TTS_MODEL_SUMMARY: TtsModelSummary = {
  contextLength: 0,
  id: CONFIG_DEFAULT_TTS_MODEL,
  name: 'Google: Gemini 3.8 Flash Lite TTS',
  pricing: {
    completion: '0.000006',
    prompt: '0.0000005',
  },
  supportedParameters: ['response_format'],
  supportsVoiceCloning: false,
  voiceHelpLabel: 'Voci OpenRouter',
  voiceHelpUrl: 'https://openrouter.ai/google/gemini-3.8-flash-lite-tts/api',
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
    const geminiTts = isGeminiTtsModel(attempt.model);
    const response = await fetch(`${OPENROUTER_API_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: getOpenRouterJsonHeaders(),
      body: JSON.stringify({
        model: attempt.model,
        input: attempt.text,
        voice: attempt.voice,
        response_format: geminiTts ? 'pcm' : TTS_RESPONSE_FORMAT,
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

    const audioBuffer = await response.arrayBuffer();
    if (geminiTts) {
      const format = new MIMEType(
        response.headers.get('content-type') || 'application/octet-stream'
      );
      const rate = format.params.get('rate') || '';
      const channelCount = format.params.get('channels') || '';
      const sampleRate = Number(rate);
      const channels = Number(channelCount);
      const bytesPerSample = 2;
      const blockAlign = channels * bytesPerSample;
      if (
        format.essence !== 'audio/pcm' ||
        !/^\d+$/.test(rate) ||
        !/^\d+$/.test(channelCount) ||
        sampleRate <= 0 ||
        channels <= 0 ||
        audioBuffer.byteLength === 0 ||
        audioBuffer.byteLength % blockAlign !== 0
      ) {
        throw new Error('Invalid Gemini TTS PCM response.');
      }
      const wav = Buffer.alloc(44 + audioBuffer.byteLength);
      wav.write('RIFF', 0);
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(channels, 22);
      wav.writeUInt32LE(sampleRate, 24);
      wav.writeUInt32LE(sampleRate * blockAlign, 28);
      wav.writeUInt16LE(blockAlign, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(audioBuffer.byteLength, 40);
      Buffer.from(audioBuffer).copy(wav, 44);
      return {
        audioBuffer: Uint8Array.from(wav).buffer,
        contentType: 'audio/wav',
        generationId: response.headers.get('x-generation-id') || undefined,
      };
    }
    return {
      audioBuffer,
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
    const model = normalizeOptionalText(request.model, DEFAULT_TTS_MODEL);
    const normalizedVoice = normalizeModelVoice(model, voice);

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
