// Backend Types for TTS Integration

export interface VoiceProfile {
  id: string;
  name: string;
  language: string;
  mode: 'voice_design';
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
  pythonExecutable: string;
  ttsServerModule: string;
  ttsServerCwd: string;
  ttsServerPort: number;
  ttsServerHost: string;
  modelId: string;
  modelCachePath: string;
  device: 'auto' | 'cuda' | 'mps' | 'cpu';
  startupTimeoutMs: number;
  healthCheckIntervalMs: number;
  restartOnCrash: boolean;
  maxRestartAttempts: number;
}

export interface TTSRequest {
  text: string;
  voice?: string; // Voice profile ID or voice design prompt
  speed?: number;
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
  currentDevice: string;
  uptime: number;
  lastError?: string;
}

export interface ProcessState {
  isRunning: boolean;
  isReady: boolean;
  pid?: number;
  startTime?: number;
  restartAttempts: number;
  lastError?: string;
}
