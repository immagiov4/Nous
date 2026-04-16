#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BACKEND_HOST = '127.0.0.1';
const DEFAULT_BACKEND_PORT = 3301;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = join(__dirname, '..', 'server.config.json');

const normalizeHost = (value, fallback = DEFAULT_BACKEND_HOST) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const normalizePort = (value, fallback = DEFAULT_BACKEND_PORT) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function getBackendRuntimeConfig() {
  let fileConfig = {};

  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      console.warn(
        `[Config] Failed to parse server.config.json: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    backendHost: normalizeHost(process.env.BACKEND_HOST || fileConfig.backendHost),
    backendPort: normalizePort(process.env.BACKEND_PORT || fileConfig.backendPort),
  };
}

export function getBackendDisplayHost(host) {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host;
}
