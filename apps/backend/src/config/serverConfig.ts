import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ServerConfig } from '../types/index.js';

import { defaultServerConfig } from './defaultServerConfig.js';
import { loadOptionalJsonFile } from './jsonFile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedConfig: ServerConfig | null = null;

const normalizeHost = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const normalizePort = (value: unknown, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getDisplayHost = (host: string): string => {
  if (host === '0.0.0.0' || host === '::') {
    return 'localhost';
  }

  return host;
};

export function loadServerConfig(): ServerConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = join(__dirname, '..', '..', '..', '..', 'server.config.json');
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

export function buildTTSServerUrl(
  config: Pick<ServerConfig, 'ttsServerHost' | 'ttsServerPort'>
): string {
  return `http://${config.ttsServerHost}:${config.ttsServerPort}`;
}

export function getBackendServerConfig(
  config: Pick<ServerConfig, 'backendHost' | 'backendPort'> = loadServerConfig()
): Pick<ServerConfig, 'backendHost' | 'backendPort'> {
  return {
    backendHost: normalizeHost(process.env.BACKEND_HOST, config.backendHost),
    backendPort: normalizePort(process.env.BACKEND_PORT, config.backendPort),
  };
}

export function buildBackendServerUrl(
  config: Pick<ServerConfig, 'backendHost' | 'backendPort'>,
  options: { displayHost?: boolean } = {}
): string {
  const host = options.displayHost ? getDisplayHost(config.backendHost) : config.backendHost;
  return `http://${host}:${config.backendPort}`;
}

export function getBackendServerUrl(options: { displayHost?: boolean } = {}): string {
  return buildBackendServerUrl(getBackendServerConfig(loadServerConfig()), options);
}

export function getTTSServerUrl(): string {
  return buildTTSServerUrl(loadServerConfig());
}
