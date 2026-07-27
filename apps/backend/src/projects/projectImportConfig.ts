const DEFAULT_PROJECT_IMPORT_CONFIG = {
  activeUploadsGlobal: 2,
  activeUploadsPerUser: 1,
  cleanupIntervalMs: 60_000,
  completedUploadTtlMs: 10 * 60_000,
  directMaxBytes: 20_000_000,
  finalizationsGlobal: 1,
  maxChunkBytes: 16_000_000,
  maxChunkCount: 32,
  maxSerializedBytes: 280_000_000,
  receivingUploadTtlMs: 15 * 60_000,
  requestsGlobal: 4,
  requestsPerUser: 1,
  requestTimeoutMs: 120_000,
} as const;

export interface ProjectImportConfig {
  activeUploadsGlobal: number;
  activeUploadsPerUser: number;
  cleanupIntervalMs: number;
  completedUploadTtlMs: number;
  directMaxBytes: number;
  finalizationsGlobal: number;
  maxChunkBytes: number;
  maxChunkCount: number;
  maxSerializedBytes: number;
  receivingUploadTtlMs: number;
  requestsGlobal: number;
  requestsPerUser: number;
  requestTimeoutMs: number;
}

const readPositiveInteger = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const configured = env[key];
  if (configured === undefined || configured === '') return fallback;
  if (!/^\d+$/u.test(configured)) {
    throw new Error(`${key} must be a positive integer.`);
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive safe integer.`);
  }
  return value;
};

export const readProjectImportConfig = (env: NodeJS.ProcessEnv): ProjectImportConfig => {
  const config: ProjectImportConfig = {
    activeUploadsGlobal: readPositiveInteger(
      env,
      'PROJECT_IMPORT_ACTIVE_UPLOADS_GLOBAL',
      DEFAULT_PROJECT_IMPORT_CONFIG.activeUploadsGlobal
    ),
    activeUploadsPerUser: readPositiveInteger(
      env,
      'PROJECT_IMPORT_ACTIVE_UPLOADS_PER_USER',
      DEFAULT_PROJECT_IMPORT_CONFIG.activeUploadsPerUser
    ),
    cleanupIntervalMs: readPositiveInteger(
      env,
      'PROJECT_IMPORT_CLEANUP_INTERVAL_MS',
      DEFAULT_PROJECT_IMPORT_CONFIG.cleanupIntervalMs
    ),
    completedUploadTtlMs: readPositiveInteger(
      env,
      'PROJECT_IMPORT_COMPLETED_TTL_MS',
      DEFAULT_PROJECT_IMPORT_CONFIG.completedUploadTtlMs
    ),
    directMaxBytes: readPositiveInteger(
      env,
      'PROJECT_IMPORT_DIRECT_MAX_BYTES',
      DEFAULT_PROJECT_IMPORT_CONFIG.directMaxBytes
    ),
    finalizationsGlobal: readPositiveInteger(
      env,
      'PROJECT_IMPORT_FINALIZATIONS_GLOBAL',
      DEFAULT_PROJECT_IMPORT_CONFIG.finalizationsGlobal
    ),
    maxChunkBytes: readPositiveInteger(
      env,
      'PROJECT_IMPORT_MAX_CHUNK_BYTES',
      DEFAULT_PROJECT_IMPORT_CONFIG.maxChunkBytes
    ),
    maxChunkCount: readPositiveInteger(
      env,
      'PROJECT_IMPORT_MAX_CHUNK_COUNT',
      DEFAULT_PROJECT_IMPORT_CONFIG.maxChunkCount
    ),
    maxSerializedBytes: readPositiveInteger(
      env,
      'PROJECT_IMPORT_MAX_SERIALIZED_BYTES',
      DEFAULT_PROJECT_IMPORT_CONFIG.maxSerializedBytes
    ),
    receivingUploadTtlMs: readPositiveInteger(
      env,
      'PROJECT_IMPORT_RECEIVING_TTL_MS',
      DEFAULT_PROJECT_IMPORT_CONFIG.receivingUploadTtlMs
    ),
    requestsGlobal: readPositiveInteger(
      env,
      'PROJECT_IMPORT_REQUESTS_GLOBAL',
      DEFAULT_PROJECT_IMPORT_CONFIG.requestsGlobal
    ),
    requestsPerUser: readPositiveInteger(
      env,
      'PROJECT_IMPORT_REQUESTS_PER_USER',
      DEFAULT_PROJECT_IMPORT_CONFIG.requestsPerUser
    ),
    requestTimeoutMs: readPositiveInteger(
      env,
      'PROJECT_IMPORT_REQUEST_TIMEOUT_MS',
      DEFAULT_PROJECT_IMPORT_CONFIG.requestTimeoutMs
    ),
  };

  if (config.activeUploadsPerUser > config.activeUploadsGlobal) {
    throw new Error(
      'PROJECT_IMPORT_ACTIVE_UPLOADS_PER_USER cannot exceed PROJECT_IMPORT_ACTIVE_UPLOADS_GLOBAL.'
    );
  }
  if (config.requestsPerUser > config.requestsGlobal) {
    throw new Error(
      'PROJECT_IMPORT_REQUESTS_PER_USER cannot exceed PROJECT_IMPORT_REQUESTS_GLOBAL.'
    );
  }
  if (config.finalizationsGlobal > config.activeUploadsGlobal) {
    throw new Error(
      'PROJECT_IMPORT_FINALIZATIONS_GLOBAL cannot exceed PROJECT_IMPORT_ACTIVE_UPLOADS_GLOBAL.'
    );
  }
  if (config.directMaxBytes > config.maxSerializedBytes) {
    throw new Error('PROJECT_IMPORT_DIRECT_MAX_BYTES cannot exceed the serialized import limit.');
  }
  if (config.maxChunkBytes < 4) {
    throw new Error('PROJECT_IMPORT_MAX_CHUNK_BYTES must fit one UTF-8 code point.');
  }
  if (config.maxChunkCount < Math.ceil(config.maxSerializedBytes / config.maxChunkBytes)) {
    throw new Error('Chunk size multiplied by chunk count must cover the serialized import limit.');
  }
  if (config.cleanupIntervalMs > config.receivingUploadTtlMs) {
    throw new Error('PROJECT_IMPORT_CLEANUP_INTERVAL_MS cannot exceed the receiving upload TTL.');
  }

  return config;
};

export const projectImportConfig = readProjectImportConfig(process.env);

export const getPublicProjectImportConfig = () => ({
  directMaxBytes: projectImportConfig.directMaxBytes,
  maxChunkBytes: projectImportConfig.maxChunkBytes,
  maxChunkCount: projectImportConfig.maxChunkCount,
  maxSerializedBytes: projectImportConfig.maxSerializedBytes,
  requestTimeoutMs: projectImportConfig.requestTimeoutMs,
});
