import { TTSRequest, VoiceProfile, VoiceProfilesConfig } from '../types/index.js';
import { getTTSServerUrl, loadServerConfig } from '../config/serverConfig.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
    
    if (existsSync(profilesPath)) {
      try {
        const content = readFileSync(profilesPath, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        console.warn('[TTSClient] Failed to load voice profiles, using defaults');
      }
    }

    // Default profiles - using supported TTS speaker names
        return {
          profiles: [
            {
              id: 'marco',
              name: 'Marco',
              language: 'it-IT',
              mode: 'voice_design',
              voiceDesignPrompt: 'eric',
              modelSettings: { temperature: 0.7, speed: 1.0 }
            },
            {
              id: 'giulia',
              name: 'Giulia',
              language: 'it-IT',
              mode: 'voice_design',
              voiceDesignPrompt: 'serena',
              modelSettings: { temperature: 0.8, speed: 1.0 }
            }
          ],
      defaultProfile: 'marco'
    };
  }

  getVoiceProfiles(): VoiceProfile[] {
    return this.voiceProfiles.profiles;
  }

  getDefaultProfile(): VoiceProfile {
    const defaultId = this.voiceProfiles.defaultProfile;
    return this.voiceProfiles.profiles.find(p => p.id === defaultId) || this.voiceProfiles.profiles[0];
  }

  getVoiceProfile(id: string): VoiceProfile | undefined {
    return this.voiceProfiles.profiles.find(p => p.id === id);
  }

  async generateSpeech(request: TTSRequest): Promise<ArrayBuffer> {
    const { text, voice, speed = 1.0 } = request;

    // Resolve voice profile
    let voicePrompt: string;
    let temperature = 0.7;

    if (voice) {
      const profile = this.getVoiceProfile(voice);
      if (profile) {
        voicePrompt = profile.voiceDesignPrompt;
        temperature = profile.modelSettings.temperature;
      } else {
        // Treat as direct voice design prompt
        voicePrompt = voice;
      }
    } else {
      const defaultProfile = this.getDefaultProfile();
      voicePrompt = defaultProfile.voiceDesignPrompt;
      temperature = defaultProfile.modelSettings.temperature;
    }

    console.log(`[TTSClient] Generating speech for ${text.length} chars with voice: ${voice || 'default'} -> using speaker: ${voicePrompt}`);

    // Call the OpenAI-compatible TTS API
    const response = await fetch(`${this.serverUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen3-tts',
        input: text,
        voice: voicePrompt,
        response_format: 'wav',
        speed: speed
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TTS API error: ${response.status} - ${errorText}`);
    }

    // Return audio as ArrayBuffer
    return response.arrayBuffer();
  }

  async checkHealth(): Promise<{ healthy: boolean; message: string }> {
    try {
      const response = await fetch(`${this.serverUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        return { healthy: true, message: 'TTS server is healthy' };
      } else {
        return { healthy: false, message: `Health check failed: ${response.status}` };
      }
    } catch (error: any) {
      return { healthy: false, message: `Connection failed: ${error.message}` };
    }
  }

  async checkReady(): Promise<{ ready: boolean; message: string }> {
    try {
      // Try a minimal TTS request to check if model is loaded
      const response = await fetch(`${this.serverUrl}/v1/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        return { ready: true, message: 'TTS server is ready' };
      } else {
        return { ready: false, message: `Ready check failed: ${response.status}` };
      }
    } catch (error: any) {
      return { ready: false, message: `Connection failed: ${error.message}` };
    }
  }
}

// Singleton instance
export const ttsClient = new TTSClient();
