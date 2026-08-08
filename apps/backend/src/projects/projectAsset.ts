import { createHash } from 'node:crypto';

import type { ProjectAssetRef } from '@shared/projectAsset';
import type { TransactionSql } from 'postgres';
import { ProjectSourceStorageError, SupabaseProjectSourceStorage } from './projectSourceStorage.js';

export const PROJECT_ASSET_BUCKET = 'project-assets';

export interface ProjectAssetDescriptor extends ProjectAssetRef {
  readonly idempotencyKey: string;
  readonly objectPath: string;
}

export interface ProjectAssetCleanupClaim extends ProjectAssetRef {
  readonly fencingToken: number;
  readonly objectPath: string;
  readonly workerId: string;
}

export interface ProjectAssetObjectStorage {
  delete(path: string, signal?: AbortSignal): Promise<void>;
  download(
    path: string,
    expected: { byteSize: number; hash: string; mimeType: string },
    signal?: AbortSignal
  ): Promise<Uint8Array>;
  upload(path: string, bytes: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<void>;
}

export interface BuildProjectAssetDescriptorInput {
  bytes: Uint8Array;
  idempotencyKey: string;
  mediaType: string;
  nodeInstanceId: string;
  projectId: string;
  runId: string;
  userId: string;
}

export interface StageProjectAssetInput extends BuildProjectAssetDescriptorInput {
  readonly signal: AbortSignal;
}

export interface AdoptProjectNodeAssetsInput {
  readonly assetIds: readonly string[];
  readonly nodeInstanceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly userId: string;
}

export interface ProjectAssetWriter {
  adoptNodeAssets(
    transaction: TransactionSql,
    input: AdoptProjectNodeAssetsInput
  ): Promise<readonly ProjectAssetRef[]>;
  stage(input: StageProjectAssetInput): Promise<ProjectAssetRef>;
}

export class ProjectAssetStoreError extends Error {
  constructor(
    public readonly code:
      | 'asset-not-adoptable'
      | 'cleanup-lease-lost'
      | 'invalid-cleanup-claim'
      | 'metadata-conflict'
      | 'scope-invalid'
  ) {
    super(`Project asset operation failed: ${code}.`);
    this.name = 'ProjectAssetStoreError';
  }
}

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const requireValue = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Project asset ${label} is required.`);
  return normalized;
};

export const buildProjectAssetDescriptor = ({
  bytes,
  idempotencyKey,
  mediaType,
  nodeInstanceId,
  projectId,
  runId,
  userId,
}: BuildProjectAssetDescriptorInput): ProjectAssetDescriptor => {
  const normalizedKey = requireValue(idempotencyKey, 'idempotency key');
  const normalizedMediaType = requireValue(mediaType, 'media type');
  const normalizedNodeInstanceId = requireValue(nodeInstanceId, 'node instance id');
  const normalizedProjectId = requireValue(projectId, 'project id');
  const normalizedRunId = requireValue(runId, 'workflow run id');
  const normalizedUserId = requireValue(userId, 'user id');
  const hash = sha256(bytes);
  const identityHash = sha256(
    JSON.stringify([
      normalizedUserId,
      normalizedProjectId,
      normalizedRunId,
      normalizedNodeInstanceId,
      normalizedKey,
    ])
  );
  const id = sha256(JSON.stringify([identityHash, hash]));
  const objectPath = [
    'users',
    normalizedUserId,
    'projects',
    sha256(normalizedProjectId),
    'assets',
    identityHash,
    hash,
  ].join('/');
  return Object.freeze({
    byteSize: bytes.byteLength,
    hash,
    id,
    idempotencyKey: normalizedKey,
    mediaType: normalizedMediaType,
    objectPath,
  });
};

export const ensureProjectAssetUploaded = async (
  storage: ProjectAssetObjectStorage,
  descriptor: ProjectAssetDescriptor,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> => {
  try {
    if (signal) await storage.upload(descriptor.objectPath, bytes, descriptor.mediaType, signal);
    else await storage.upload(descriptor.objectPath, bytes, descriptor.mediaType);
  } catch (error) {
    if (!(error instanceof ProjectSourceStorageError) || error.status !== 409) throw error;
    const expected = {
      byteSize: descriptor.byteSize,
      hash: descriptor.hash,
      mimeType: descriptor.mediaType,
    };
    if (signal) await storage.download(descriptor.objectPath, expected, signal);
    else await storage.download(descriptor.objectPath, expected);
  }
};

export const createProjectAssetStorage = (config: {
  fetcher?: typeof fetch;
  serviceRoleKey: string;
  supabaseUrl: string;
}): ProjectAssetObjectStorage =>
  new SupabaseProjectSourceStorage({ ...config, bucket: PROJECT_ASSET_BUCKET });
