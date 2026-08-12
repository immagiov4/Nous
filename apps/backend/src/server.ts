// Express server bootstrap for the backend API.
import './config/env.js';

import { closeBackendResources } from './backendShutdown.js';
import {
  buildBackendServerUrl,
  getBackendServerConfig,
  loadServerConfig,
} from './config/serverConfig.js';
import { createApp } from './index.js';
import { closeManagedCodexAccountClient } from './services/codexAppServer.js';
import { startFeedbackOutboxWorker, stopFeedbackOutboxWorker } from './services/feedbackService.js';
import { DEFAULT_TTS_MODEL } from './services/ttsClient.js';
import { createWorkflowRuntimeComposition } from './workflows/workflowRuntimeComposition.js';

const workflowRuntime = createWorkflowRuntimeComposition();
const app = createApp({
  artifactDraftApi: workflowRuntime.artifactDraftApi,
  courseGenerationApi: workflowRuntime.courseGenerationApi,
  courseInterviewApi: workflowRuntime.courseInterviewApi,
  lessonGenerationApi: workflowRuntime.lessonGenerationApi,
  lessonVisualRetryStarter: workflowRuntime.lessonVisualRetryStarter,
  pdfMappingRepairApi: workflowRuntime.pdfMappingRepairApi,
  projectAssetReader: workflowRuntime.projectAssetReader,
  workflowOutboxAdmin: workflowRuntime.workflowOutboxAdmin,
  workflowRuntimeApi: workflowRuntime.api,
});
const config = loadServerConfig();
const backendConfig = getBackendServerConfig(config);

startFeedbackOutboxWorker();
try {
  await workflowRuntime.start();
} catch (error) {
  console.error('[Backend] Workflow runtime failed to start.', error);
  await workflowRuntime.close();
  throw error;
}
const server = app.listen(backendConfig.backendPort, backendConfig.backendHost, () => {
  const backendUrl = buildBackendServerUrl(backendConfig, { displayHost: true });
  console.log(`[Backend] Server running on ${backendUrl}`);
  console.log(`[Backend] TTS API available at ${backendUrl}/api/tts`);
  console.log(`[Backend] STT API available at ${backendUrl}/api/stt`);
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
  try {
    await closeBackendResources({
      closeCodex: closeManagedCodexAccountClient,
      closeHttpServer: () =>
        new Promise((resolve, reject) => {
          server.close(error => {
            if (error) reject(error);
            else resolve();
          });
        }),
      closeWorkflow: workflowRuntime.close,
      stopFeedback: stopFeedbackOutboxWorker,
    });
    process.exit(0);
  } catch (error) {
    console.error('[Backend] Shutdown failed.', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
