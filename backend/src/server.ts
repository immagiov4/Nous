import { buildTTSServerUrl, loadServerConfig } from './config/serverConfig.js';
import { createApp } from './index.js';
import { processManager } from './services/processManager.js';

const app = createApp();
const config = loadServerConfig();
const PORT = process.env.BACKEND_PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`[Backend] Server running on http://localhost:${PORT}`);
  console.log(`[Backend] TTS API available at http://localhost:${PORT}/api/tts`);
  console.log(`[Backend] Expecting TTS server at ${buildTTSServerUrl(config)}`);
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
