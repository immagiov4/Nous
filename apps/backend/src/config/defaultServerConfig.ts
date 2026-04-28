import type { ServerConfig } from '../types/index.js';

export const defaultServerConfig: ServerConfig = {
  backendHost: '127.0.0.1',
  backendPort: 3301,
  pythonExecutable: 'python',
  ttsServerModule: 'api.main',
  ttsServerCwd: './services/tts-server',
  ttsServerPort: 8880,
  ttsServerHost: '127.0.0.1',
  modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
  modelCachePath: './models',
  device: 'auto',
  startupTimeoutMs: 120000,
  healthCheckIntervalMs: 5000,
  restartOnCrash: true,
  maxRestartAttempts: 3,
};
