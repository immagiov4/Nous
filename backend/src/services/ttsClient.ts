import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOptionalJsonFile } from '../config/jsonFile.js';

import { getTTSServerUrl, loadServerConfig } from '../config/serverConfig.js';
import type { TTSRequest, VoiceProfile, VoiceProfilesConfig } from '../types/index.js';
import { checkTtsHealth, checkTtsReadiness } from './ttsHealth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class TTSClient {
  private serverUrl: string;
  private voiceProfiles: VoiceProfilesConfig;

  constructor() {
    this.serverUrl = getTTSServerUrl();
    this.voiceProfiles = this.loadVoiceProfiles();
  }

  private loadVoiceProfiles(): VoiceProfilesConfig {
    const profilesPath = join(__dirname, '..', 'config', 'voice-profiles.json');
    const loadedProfiles = loadOptionalJsonFile<VoiceProfilesConfig>(
      profilesPath,
      'voice-profiles.json'
    );

    if (loadedProfiles) {
      return loadedProfiles;
    }

    return {
      profiles: [
        {
          id: 'mario',
          name: 'Mario',
          language: 'it-IT',
          mode: 'voice_design',
          voiceDesignPrompt: 'clone:Mario',
          modelSettings: { temperature: 0.7, speed: 1.0 },
        },
      ],
      defaultProfile: 'mario',
    };
  }

  getVoiceProfiles(): VoiceProfile[] {
    return this.voiceProfiles.profiles;
  }

  getDefaultProfile(): VoiceProfile {
    const defaultId = this.voiceProfiles.defaultProfile;
    return (
      this.voiceProfiles.profiles.find(p => p.id === defaultId) || this.voiceProfiles.profiles[0]
    );
  }

  getVoiceProfile(id: string): VoiceProfile | undefined {
    return this.voiceProfiles.profiles.find(p => p.id === id);
  }

  private normalizeOpenAiModel(modelId: string | undefined): string {
    if (!modelId) {
      return 'qwen3-tts';
    }

    const normalized = modelId.trim();
    if (normalized === 'qwen3-tts' || normalized === 'tts-1' || normalized === 'tts-1-hd') {
      return normalized;
    }

    return 'qwen3-tts';
  }

  private async getErrorDetails(response: Response): Promise<string> {
    const responseText = await response.text();

    if (!responseText) {
      return response.statusText || 'Unknown TTS error';
    }

    try {
      const parsed = JSON.parse(responseText) as {
        detail?: { message?: string; error?: string };
        message?: string;
        error?: string;
      };

      return (
        parsed.detail?.message ||
        parsed.detail?.error ||
        parsed.message ||
        parsed.error ||
        responseText
      );
    } catch (error) {
      console.warn('[Nous] Failed to parse TTS error response JSON', error);
      return responseText;
    }
  }

  async generateSpeech(request: TTSRequest): Promise<ArrayBuffer> {
    const { text, voice, speed = 1.0 } = request;
    const config = loadServerConfig();
    const selectedProfile = voice
      ? (this.getVoiceProfile(voice) ?? this.getDefaultProfile())
      : this.getDefaultProfile();
    const temperature = selectedProfile.modelSettings.temperature;
    const voicePrompt = 'clone:Mario';

    console.log(
      `[TTSClient] Generating speech for ${text.length} chars with voice: ${voice || 'default'} -> using speaker: ${voicePrompt}`
    );

    const response = await fetch(`${this.serverUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.normalizeOpenAiModel(config.modelId),
        input: text,
        voice: voicePrompt,
        response_format: 'wav',
        speed,
        temperature,
      }),
    });

    if (!response.ok) {
      const errorText = await this.getErrorDetails(response);
      throw new Error(`TTS API error: ${response.status} - ${errorText}`);
    }

    return response.arrayBuffer();
  }

  async checkHealth(): Promise<{ healthy: boolean; message: string }> {
    return checkTtsHealth(loadServerConfig());
  }

  async checkReady(): Promise<{ ready: boolean; message: string }> {
    return checkTtsReadiness(loadServerConfig());
  }
}

export const ttsClient = new TTSClient();
