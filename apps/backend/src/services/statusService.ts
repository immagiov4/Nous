import { ttsClient } from './ttsClient.js';

export interface StatusSnapshot {
  healthMessage: string;
  isReady: boolean;
  isRunning: boolean;
  lastError?: string;
  modelLoaded: boolean;
}

export async function getStatusSnapshot(): Promise<StatusSnapshot> {
  const readiness = await ttsClient.checkReady();

  return {
    healthMessage: readiness.message,
    isReady: readiness.ready,
    isRunning: readiness.ready,
    lastError: readiness.ready ? undefined : readiness.message,
    modelLoaded: readiness.ready,
  };
}
