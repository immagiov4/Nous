// Backend Types for TTS Integration

export interface VoiceProfile {
  id: string;
  name: string;
  language: string;
  mode: 'openrouter_voice' | 'voice_design';
  voiceDesignPrompt: string;
  modelSettings: {
    temperature: number;
    speed: number;
  };
}

export interface VoiceProfilesConfig {
  profiles: VoiceProfile[];
  defaultProfile: string;
}

export interface ServerConfig {
  backendHost: string;
  backendPort: number;
}

export interface TTSRequest {
  text: string;
  model?: string;
  voice?: string;
  speed?: number;
}

export interface GeneratedSpeechAudio {
  audioBuffer: ArrayBuffer;
  contentType: string;
  generationId?: string;
}

export interface TtsModelSummary {
  contextLength: number;
  id: string;
  name: string;
  pricing: {
    completion: string;
    prompt: string;
  };
  supportedParameters: string[];
  supportsVoiceCloning: boolean;
  voiceHelpLabel?: string;
  voiceHelpUrl?: string;
}

export interface TTSResponse {
  success: boolean;
  audioUrl?: string; // Base64 encoded audio or blob URL
  error?: string;
}

export interface TTSStatus {
  isRunning: boolean;
  isReady: boolean;
  modelLoaded: boolean;
  lastError?: string;
}
