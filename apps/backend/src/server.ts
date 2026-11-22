// Express server bootstrap for the backend API.
import type { Server } from 'node:http';

import './config/env.js';
import { closeAccountStore } from './account/accountStore.js';
import { closeBackendResources } from './backendShutdown.js';
import { getResolvedGlobalModelConfig } from './config/modelConfig.js';
import {
  buildBackendServerUrl,
  getBackendServerConfig,
  loadServerConfig,
} from './config/serverConfig.js';
import { createApp } from './index.js';
import { createLibraryExportApi } from './projects/libraryExport.js';
import { readLibraryExportConfig } from './projects/libraryExportConfig.js';
import { PostgresLibraryExportRunStore } from './projects/libraryExportRunStore.js';
import { getProjectStore } from './projects/projectStore.js';
import { closeManagedCodexAccountClient } from './services/codexAppServer.js';
import { startFeedbackOutboxWorker, stopFeedbackOutboxWorker } from './services/feedbackService.js';
import { loadIconIndex } from './services/lessonScenes/lessonSceneIcons.js';
import { closeSpeechPreparationCache } from './services/speechPreparationCache.js';
import { DEFAULT_TTS_MODEL } from './services/ttsClient.js';
import {
  type CreateWorkflowRuntimeCompositionOptions,
  createWorkflowRuntimeComposition,
} from './workflows/runtime/workflowRuntimeComposition.js';
import {
  WorkflowDefinitionDeploymentConflictError,
  WorkflowDefinitionRegistryDeploymentConflictError,
} from './workflows/workflowErrors.js';

const RELEASE_REJECTED_STATUS = 65;

const closeHttpServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });

async function checkReleaseHealth(app: ReturnType<typeof createApp>, port: number): Promise<void> {
  const host = '127.0.0.1';
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once('error', reject);
  });
  try {
    const response = await fetch(`http://${host}:${port}/health`);
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Candidate health check returned HTTP ${response.status}.`);
  } finally {
    await closeHttpServer(server);
  }
}

/** Start the product server and its owned workers with the supplied runtime dependencies. */
export async function startBackend(
  options: CreateWorkflowRuntimeCompositionOptions = {},
  mode: 'serve' | 'check-release' = 'serve'
): Promise<void> {
  const workflowRuntime = createWorkflowRuntimeComposition(options);
  const libraryExportApi = createLibraryExportApi({
    config: readLibraryExportConfig(process.env),
    assetReader: workflowRuntime.projectAssetReader,
    projectStore: getProjectStore(),
    runStore: new PostgresLibraryExportRunStore(),
  });
  const app = createApp({
    artifactDraftApi: workflowRuntime.artifactDraftApi,
    courseGenerationApi: workflowRuntime.courseGenerationApi,
    courseInterviewApi: workflowRuntime.courseInterviewApi,
    lessonGenerationApi: workflowRuntime.lessonGenerationApi,
    lessonPlaybackApi: workflowRuntime.lessonPlaybackApi,
    lessonVisualRetryStarter: workflowRuntime.lessonVisualRetryStarter,
    libraryExportApi,
    pdfMappingRepairApi: workflowRuntime.pdfMappingRepairApi,
    projectAssetReader: workflowRuntime.projectAssetReader,
    workflowOutboxAdmin: workflowRuntime.workflowOutboxAdmin,
    workflowRuntimeApi: workflowRuntime.api,
  });
  const config = loadServerConfig();
  const backendConfig = getBackendServerConfig(config);

  if (mode === 'check-release') {
    try {
      await workflowRuntime.checkRelease();
      await checkReleaseHealth(app, backendConfig.backendPort);
    } finally {
      await workflowRuntime.close();
    }
    console.info('[Backend] Candidate is healthy; workflow authority is unchanged.');
    return;
  }

  startFeedbackOutboxWorker();
  try {
    await workflowRuntime.start();
  } catch (error) {
    console.error('[Backend] Workflow runtime failed to start.', error);
    await workflowRuntime.close();
    throw error;
  }
  try {
    await libraryExportApi.recoverPendingRuns();
  } catch (error) {
    console.error('[Backend] Library export recovery failed.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    await workflowRuntime.close();
    throw error;
  }
  const server = app.listen(backendConfig.backendPort, backendConfig.backendHost, () => {
    const backendUrl = buildBackendServerUrl(backendConfig, { displayHost: true });
    console.log(`[Backend] Server running on ${backendUrl}`);
    console.log(`[Backend] TTS API available at ${backendUrl}/api/tts`);
    console.log(`[Backend] STT API available at ${backendUrl}/api/stt`);
    console.log(`[Backend] OpenRouter TTS default model: ${DEFAULT_TTS_MODEL}`);
    // Build or load the icon index now, so the first lesson scene does not wait for it.
    void getResolvedGlobalModelConfig()
      .then(config => loadIconIndex(config.embeddingModel))
      .catch(error => {
        console.error('[Backend] Icon index warm-up failed.', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
      });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    const backendUrl = buildBackendServerUrl(backendConfig, { displayHost: true });
    const reconfigureHint =
      'Update "backendPort" in config/server.config.json or set BACKEND_PORT/VITE_BACKEND_PORT to an open port.';

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
        closeAccountStore,
        closeSpeechPreparation: closeSpeechPreparationCache,
        closeLibraryExports: libraryExportApi.close,
        closeCodex: closeManagedCodexAccountClient,
        closeHttpServer: () => closeHttpServer(server),
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
}

/** Return the deployment exit status without changing the calling process. */
export async function runBackendReleaseCheck(): Promise<number> {
  try {
    await startBackend({}, 'check-release');
    return 0;
  } catch (error) {
    const rejected =
      error instanceof WorkflowDefinitionDeploymentConflictError ||
      error instanceof WorkflowDefinitionRegistryDeploymentConflictError;
    console.error(
      rejected ? '[Backend] Candidate release rejected.' : '[Backend] Candidate check failed.',
      { errorType: error instanceof Error ? error.name : 'UnknownError' }
    );
    return rejected ? RELEASE_REJECTED_STATUS : 1;
  }
}

if (import.meta.main) {
  if (process.argv.includes('--release-check')) {
    process.exitCode = await runBackendReleaseCheck();
  } else {
    await startBackend();
  }
}
