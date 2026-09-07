const DEFAULT_LIBRARY_EXPORT_CONFIG = {
  executionsGlobal: 1,
  retentionMs: 24 * 60 * 60_000,
  cleanupIntervalMs: 15 * 60_000,
} as const;

export interface LibraryExportConfig {
  executionsGlobal: number;
  retentionMs: number;
  cleanupIntervalMs: number;
}

const readPositiveInteger = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const configured = env[key];
  if (configured === undefined || configured === '') return fallback;
  const value = Number(configured);
  if (!/^\d+$/u.test(configured) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive safe integer.`);
  }
  return value;
};

// Bun and Node clamp larger timer delays to one millisecond.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export const readLibraryExportConfig = (env: NodeJS.ProcessEnv): LibraryExportConfig => {
  const config = {
    executionsGlobal: readPositiveInteger(
      env,
      'LIBRARY_EXPORT_EXECUTIONS_GLOBAL',
      DEFAULT_LIBRARY_EXPORT_CONFIG.executionsGlobal
    ),
    retentionMs: readPositiveInteger(
      env,
      'LIBRARY_EXPORT_RETENTION_MS',
      DEFAULT_LIBRARY_EXPORT_CONFIG.retentionMs
    ),
    cleanupIntervalMs: readPositiveInteger(
      env,
      'LIBRARY_EXPORT_CLEANUP_INTERVAL_MS',
      DEFAULT_LIBRARY_EXPORT_CONFIG.cleanupIntervalMs
    ),
  };
  if (config.cleanupIntervalMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`LIBRARY_EXPORT_CLEANUP_INTERVAL_MS must not exceed ${MAX_TIMER_DELAY_MS}.`);
  }
  if (Number.isNaN(new Date(Date.now() - config.retentionMs).getTime())) {
    throw new RangeError('LIBRARY_EXPORT_RETENTION_MS must produce a valid expiration date.');
  }
  return config;
};
