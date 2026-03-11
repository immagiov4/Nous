import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ServerConfig } from '../types/index.js';

import { defaultServerConfig } from './defaultServerConfig.js';
import { loadOptionalJsonFile } from './jsonFile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedConfig: ServerConfig | null = null;

export function loadServerConfig(): ServerConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = join(__dirname, '..', '..', '..', 'server.config.json');
  const hasConfigFile = existsSync(configPath);
  const userConfig = hasConfigFile
    ? loadOptionalJsonFile<Partial<ServerConfig>>(configPath, 'server.config.json')
    : null;

  if (userConfig) {
    cachedConfig = { ...defaultServerConfig, ...userConfig };
    console.log('[Config] Loaded server.config.json');
  } else if (!hasConfigFile) {
    console.log('[Config] No server.config.json found, using defaults');
    cachedConfig = defaultServerConfig;
  } else {
    cachedConfig = defaultServerConfig;
  }

  return cachedConfig ?? defaultServerConfig;
}

export function buildTTSServerUrl(config: Pick<ServerConfig, 'ttsServerHost' | 'ttsServerPort'>): string {
  return `http://${config.ttsServerHost}:${config.ttsServerPort}`;
}

export function getTTSServerUrl(): string {
  return buildTTSServerUrl(loadServerConfig());
}
