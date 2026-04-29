import './config/env.js';

import {
  buildBackendServerUrl,
  getBackendServerConfig,
  loadServerConfig,
} from './config/serverConfig.js';
import { createApp } from './index.js';
import { processManager } from './services/processManager.js';
import { DEFAULT_TTS_MODEL } from './services/ttsClient.js';

const app = createApp();
const config = loadServerConfig();
const backendConfig = getBackendServerConfig(config);

const server = app.listen(backendConfig.backendPort, backendConfig.backendHost, () => {
  const backendUrl = buildBackendServerUrl(backendConfig, { displayHost: true });
  console.log(`[Backend] Server running on ${backendUrl}`);
  console.log(`[Backend] TTS API available at ${backendUrl}/api/tts`);
  console.log(`[Backend] OpenRouter TTS default model: ${DEFAULT_TTS_MODEL}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  const backendUrl = buildBackendServerUrl(backendConfig, { displayHost: true });
  const reconfigureHint =
    'Update "backendPort" in server.config.json or set BACKEND_PORT/VITE_BACKEND_PORT to an open port.';

  if (error.code === 'EACCES') {
    console.error(`[Backend] Permission denied while binding ${backendUrl}. ${reconfigureHint}`);
    process.exit(1);
  }

  if (error.code === 'EADDRINUSE') {
    console.error(`[Backend] ${backendUrl} is already in use. ${reconfigureHint}`);
    process.exit(1);
  }

  console.error('[Backend] Failed to start server:', error);
  process.exit(1);
});

let isShuttingDown = false;

const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`[Backend] ${signal} received, shutting down...`);
  await processManager.stop();
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
