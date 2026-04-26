import { loadServerConfig } from '../config/serverConfig.js';
import type { ProcessState, ServerConfig } from '../types/index.js';
import { processManager } from './processManager.js';
import { ttsClient } from './ttsClient.js';

export interface StatusSnapshot {
  currentDevice: ServerConfig['device'];
  healthMessage: string;
  isReady: boolean;
  isRunning: boolean;
  lastError?: string;
  modelLoaded: boolean;
  pid?: number;
  restartAttempts: number;
  uptime: number;
}

function getUptime(processState: ProcessState): number {
  if (!processState.startTime) {
    return 0;
  }

  return Math.floor((Date.now() - processState.startTime) / 1000);
}

export async function getStatusSnapshot(): Promise<StatusSnapshot> {
  const processState = processManager.getState();
  const config = loadServerConfig();
  const readiness = await ttsClient.checkReady();

  return {
    currentDevice: config.device,
    healthMessage: readiness.message,
    isReady: readiness.ready,
    isRunning: readiness.ready,
    lastError: processState.lastError,
    modelLoaded: readiness.ready,
    pid: processState.pid,
    restartAttempts: processState.restartAttempts,
    uptime: getUptime(processState),
  };
}
