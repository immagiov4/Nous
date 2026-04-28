import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireOpenRouterApiKey } from '../config/chatConfig.js';
import { loadOptionalJsonFile } from '../config/jsonFile.js';
import type {
  GeneratedSpeechAudio,
  TTSRequest,
  TtsModelSummary,
  VoiceProfile,
  VoiceProfilesConfig,
} from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_TTS_MODEL =
  process.env.MODEL_TTS || process.env.TTS_MODEL_NAME || 'openai/gpt-4o-mini-tts-2025-12-15';
export const DEFAULT_TTS_VOICE = process.env.TTS_VOICE || 'coral';
export const TTS_RESPONSE_FORMAT = 'mp3';
const OPENROUTER_APP_REFERER = process.env.OPENROUTER_APP_REFERER || 'http://localhost:5173';
const OPENROUTER_APP_TITLE = 'Nous Reader';

interface OpenRouterErrorPayload {
  error?: {
    message?: string;
  };
  message?: string;
}

interface OpenRouterSpeechAttempt {
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

const OPENAI_TTS_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
]);

const OPENAI_TTS_MODEL_SUMMARY: TtsModelSummary = {
  contextLength: 0,
  id: DEFAULT_TTS_MODEL,
  name: 'OpenAI: GPT-4o Mini TTS',
  pricing: {
    completion: '0',
    prompt: '0.0000006',
  },
  supportedParameters: ['response_format'],
  supportsVoiceCloning: false,
  voiceHelpLabel: 'Voci OpenAI',
  voiceHelpUrl: 'https://developers.openai.com/api/docs/guides/text-to-speech#voice-options',
};

const createDefaultVoiceProfiles = (): VoiceProfilesConfig => ({
  profiles: [
    {
      id: DEFAULT_TTS_VOICE,
      name: DEFAULT_TTS_VOICE,
      language: 'it-IT',
      mode: 'openrouter_voice',
      voiceDesignPrompt: DEFAULT_TTS_VOICE,
      modelSettings: { temperature: 0.7, speed: 1.0 },
    },
  ],
  defaultProfile: DEFAULT_TTS_VOICE,
});

const getOpenRouterHeaders = () => ({
  Authorization: `Bearer ${requireOpenRouterApiKey()}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': OPENROUTER_APP_REFERER,
  'X-OpenRouter-Title': OPENROUTER_APP_TITLE,
});

const normalizeOptionalText = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim();
  return trimmed || fallback;
};

const normalizeOpenAiVoice = (voice: string): string => {
  const normalizedVoice = voice.trim();

  return OPENAI_TTS_VOICES.has(normalizedVoice) ? normalizedVoice : DEFAULT_TTS_VOICE;
};

const parseOpenRouterError = async (response: Response): Promise<string> => {
  const responseText = await response.text();
  if (!responseText) {
    return response.statusText || 'Unknown OpenRouter TTS error';
  }

  try {
    const payload = JSON.parse(responseText) as OpenRouterErrorPayload;
    return payload.error?.message || payload.message || responseText;
  } catch {
    return responseText;
  }
};

class TTSClient {
  private voiceProfiles: VoiceProfilesConfig;

  constructor() {
    this.voiceProfiles = this.loadVoiceProfiles();
  }

  private loadVoiceProfiles(): VoiceProfilesConfig {
    const profilesPath = join(__dirname, '..', 'config', 'voice-profiles.json');
    const loadedProfiles = loadOptionalJsonFile<VoiceProfilesConfig>(
      profilesPath,
      'voice-profiles.json'
    );

    return loadedProfiles ?? createDefaultVoiceProfiles();
  }

  getVoiceProfiles(): VoiceProfile[] {
    return this.voiceProfiles.profiles;
  }

  getDefaultProfile(): VoiceProfile {
    const defaultId = this.voiceProfiles.defaultProfile;
    return (
      this.voiceProfiles.profiles.find(profile => profile.id === defaultId) ||
      this.voiceProfiles.profiles[0] ||
      createDefaultVoiceProfiles().profiles[0]
    );
  }

  getVoiceProfile(id: string): VoiceProfile | undefined {
    return this.voiceProfiles.profiles.find(profile => profile.id === id);
  }

  private async requestSpeech(attempt: OpenRouterSpeechAttempt): Promise<GeneratedSpeechAudio> {
    const response = await fetch(`${OPENROUTER_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: getOpenRouterHeaders(),
      body: JSON.stringify({
        model: DEFAULT_TTS_MODEL,
        input: attempt.text,
        voice: attempt.voice,
        response_format: TTS_RESPONSE_FORMAT,
        speed: attempt.speed,
      }),
    });

    if (!response.ok) {
      const details = await parseOpenRouterError(response);
      console.warn('[Nous] OpenRouter TTS request failed', {
        status: response.status,
        model: DEFAULT_TTS_MODEL,
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
    const normalizedVoice = normalizeOpenAiVoice(voice);

    console.log(
      `[TTSClient] Generating OpenRouter OpenAI speech for ${request.text.length} chars with voice: ${normalizedVoice}`
    );

    return this.requestSpeech({
      text: request.text,
      voice: normalizedVoice,
      speed: request.speed,
    });
  }

  async listModels(): Promise<TtsModelSummary[]> {
    return [OPENAI_TTS_MODEL_SUMMARY];
  }

  async checkReady(): Promise<{ message: string; ready: boolean }> {
    try {
      requireOpenRouterApiKey();
      await this.listModels();
      return {
        ready: true,
        message: 'OpenRouter TTS is ready',
      };
    } catch (error) {
      return {
        ready: false,
        message: error instanceof Error ? error.message : 'OpenRouter TTS is not ready',
      };
    }
  }
}

export const ttsClient = new TTSClient();
