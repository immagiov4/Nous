import type { ProcessState, ServerConfig } from '../types/index.js';

import { loadServerConfig } from '../config/serverConfig.js';
import { processManager } from './processManager.js';
import { checkTtsHealth } from './ttsHealth.js';

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
  const health = await checkTtsHealth(config);

  return {
    currentDevice: config.device,
    healthMessage: health.message,
    isReady: health.healthy,
    isRunning: processState.isRunning || health.healthy,
    lastError: processState.lastError,
    modelLoaded: health.healthy,
    pid: processState.pid,
    restartAttempts: processState.restartAttempts,
    uptime: getUptime(processState),
  };
}
