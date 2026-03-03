import { ServerConfig } from '../types/index.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default configuration
const defaultConfig: ServerConfig = {
  pythonExecutable: 'python',
  ttsServerModule: 'api.main',
  ttsServerCwd: './tts-server',
  ttsServerPort: 8000,
  ttsServerHost: '127.0.0.1',
  modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
  modelCachePath: './models',
  device: 'auto',
  startupTimeoutMs: 120000,
  healthCheckIntervalMs: 5000,
  restartOnCrash: true,
  maxRestartAttempts: 3
};

let cachedConfig: ServerConfig | null = null;

export function loadServerConfig(): ServerConfig {
  if (cachedConfig) return cachedConfig;

  // Try to load from project root server.config.json
  const configPath = join(__dirname, '..', '..', '..', 'server.config.json');
  
  if (existsSync(configPath)) {
    try {
      const fileContent = readFileSync(configPath, 'utf-8');
      const userConfig = JSON.parse(fileContent);
      cachedConfig = { ...defaultConfig, ...userConfig };
      console.log('[Config] Loaded server.config.json');
    } catch (error) {
      console.warn('[Config] Failed to parse server.config.json, using defaults');
      cachedConfig = defaultConfig;
    }
  } else {
    console.log('[Config] No server.config.json found, using defaults');
    cachedConfig = defaultConfig;
  }

  return cachedConfig;
}

export function getTTSServerUrl(): string {
  const config = loadServerConfig();
  return `http://${config.ttsServerHost}:${config.ttsServerPort}`;
}
