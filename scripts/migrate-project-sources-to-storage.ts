import { createHash } from 'node:crypto';

import postgres from 'postgres';

import { buildProjectSourceObjectPath } from '../apps/backend/src/projects/projectSource.js';
import {
  PROJECT_SOURCE_BUCKET,
  ProjectSourceStorageError,
  SupabaseProjectSourceStorage,
  verifyProjectSourceBytes,
} from '../apps/backend/src/projects/projectSourceStorage.js';

const HISTORICAL_SOURCE_MIME_TYPE = 'text/plain; charset=utf-8';
const SOURCE_ID_PATTERN = /^source-[A-Za-z0-9._-]+$/u;

export const PROJECT_SOURCE_STORAGE_STAGE_DDL = `
drop table if exists public.project_source_storage_stage;
create table public.project_source_storage_stage (
  user_id uuid not null,
  project_id text not null,
  migration_kind text not null
    check (migration_kind in ('project-source-row', 'embedded-source-set', 'historical-codebase')),
  source_id text not null,
  source_hash text not null,
  name text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  object_path text not null,
  staged_snapshot jsonb,
  source_files jsonb not null default '[]'::jsonb,
  staged_at timestamptz not null default now(),
  primary key (user_id, project_id),
  unique (object_path),
  foreign key (user_id, project_id)
    references public.project_snapshots(user_id, id) on delete cascade,
  check (migration_kind <> 'historical-codebase' or staged_snapshot is not null),
  check (jsonb_array_length(source_files) > 0),
  check (jsonb_typeof(source_files) = 'array')
);
alter table public.project_source_storage_stage enable row level security;
revoke all on public.project_source_storage_stage from anon, authenticated;
`.trim();

export type ProjectSourceDataMigrationErrorCode =
  | 'bucket-not-private'
  | 'bucket-request-failed'
  | 'configuration-invalid'
  | 'database-failed'
  | 'source-integrity-mismatch'
  | 'source-unmigratable'
  | 'storage-collision'
  | 'storage-request-failed';

const ERROR_MESSAGES: Record<ProjectSourceDataMigrationErrorCode, string> = {
  'bucket-not-private': 'Project source migration requires a private storage bucket.',
  'bucket-request-failed': 'Project source migration could not verify its storage bucket.',
  'configuration-invalid': 'Project source migration configuration is invalid.',
  'database-failed': 'Project source migration database operation failed.',
  'source-integrity-mismatch': 'Project source migration found inconsistent source metadata.',
  'source-unmigratable': 'Project source migration found a source that cannot be migrated.',
  'storage-collision': 'Project source migration found a conflicting storage object.',
  'storage-request-failed': 'Project source migration storage request failed.',
};

export class ProjectSourceDataMigrationError extends Error {
  constructor(
    public readonly code: ProjectSourceDataMigrationErrorCode,
    public readonly projectId?: string
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ProjectSourceDataMigrationError';
  }
}

export interface LegacyProjectSourceRow {
  byte_size: number | string;
  data: Uint8Array;
  mime_type: string;
  name: string;
  project_id: string;
  source_hash: string;
  source_id: string;
  user_id: string;
}

export interface LegacyProjectSnapshotRow {
  project_id: string;
  snapshot: unknown;
  user_id: string;
}

export type ProjectSourceMigrationKind =
  | 'embedded-source-set'
  | 'historical-codebase'
  | 'project-source-row';

export interface StagedProjectSourceFile {
  byteSize: number;
  mimeType: string;
  name: string;
  objectPath: string;
  position: number;
  sourceHash: string;
  sourceId: string;
}

export interface ProjectSourceStorageStageRow {
  byte_size: number;
  migration_kind: ProjectSourceMigrationKind;
  mime_type: string;
  name: string;
  object_path: string;
  project_id: string;
  source_hash: string;
  source_id: string;
  source_files: StagedProjectSourceFile[];
  staged_snapshot: unknown | null;
  user_id: string;
}

export interface ProjectSourceMigrationObject {
  byteSize: number;
  bytes: Uint8Array;
  hash: string;
  mimeType: string;
  objectPath: string;
  projectId: string;
}

export interface ProjectSourceMigrationCandidate {
  bytes: Uint8Array;
  objects: ProjectSourceMigrationObject[];
  stage: ProjectSourceStorageStageRow;
}

interface MigrationSourceRef {
  byteSize: number;
  hash: string;
  id: string;
  mimeType: string;
  name: string;
  objectPath: string;
}

export type ProjectSourceSchemaState = 'cutover' | 'fresh' | 'legacy';

export interface ProjectSourceSchemaInspection {
  has_data: boolean;
  has_project_snapshots: boolean;
  has_project_source_deletions: boolean;
  has_project_source_entries: boolean;
  has_project_source_files: boolean;
  has_project_sources: boolean;
  has_source_kind: boolean;
}

export interface ProjectSourceMigrationRepository {
  getSchemaState(): Promise<ProjectSourceSchemaState>;
  ensureStageTable(): Promise<void>;
  listLegacyProjectSources(): Promise<LegacyProjectSourceRow[]>;
  listProjectSnapshots(): Promise<LegacyProjectSnapshotRow[]>;
  replaceStage(rows: ProjectSourceStorageStageRow[]): Promise<void>;
}

export interface ProjectSourceMigrationStorage {
  download(path: string, expected: { byteSize: number; hash: string }): Promise<Uint8Array>;
  upload(path: string, bytes: Uint8Array, mimeType: string): Promise<void>;
}

export interface EnsurePrivateProjectSourceBucketConfig {
  fetcher?: typeof fetch;
  serviceRoleKey: string;
  supabaseUrl: string;
}

export interface ProjectSourceMigrationDependencies {
  ensureBucket(): Promise<void>;
  repository: ProjectSourceMigrationRepository;
  storage: ProjectSourceMigrationStorage;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAbsentOrEmptyArray = (value: unknown): boolean =>
  value === undefined || value === null || (Array.isArray(value) && value.length === 0);

const migrationError = (code: ProjectSourceDataMigrationErrorCode, projectId?: string) =>
  new ProjectSourceDataMigrationError(code, projectId);

export const classifyProjectSourceSchemaState = (
  inspection: ProjectSourceSchemaInspection
): ProjectSourceSchemaState => {
  const {
    has_data: hasData,
    has_project_snapshots: hasProjectSnapshots,
    has_project_source_deletions: hasProjectSourceDeletions,
    has_project_source_entries: hasProjectSourceEntries,
    has_project_source_files: hasProjectSourceFiles,
    has_project_sources: hasProjectSources,
    has_source_kind: hasSourceKind,
  } = inspection;
  const hasAnyFinalTable =
    hasProjectSourceDeletions || hasProjectSourceEntries || hasProjectSourceFiles;

  if (
    !hasProjectSnapshots &&
    !hasProjectSources &&
    !hasData &&
    !hasSourceKind &&
    !hasAnyFinalTable
  ) {
    return 'fresh';
  }
  if (hasProjectSnapshots && hasProjectSources && hasData && !hasSourceKind && !hasAnyFinalTable) {
    return 'legacy';
  }
  if (
    hasProjectSnapshots &&
    hasProjectSources &&
    !hasData &&
    hasSourceKind &&
    hasProjectSourceDeletions &&
    hasProjectSourceEntries &&
    hasProjectSourceFiles
  ) {
    return 'cutover';
  }
  throw migrationError('database-failed');
};

const requireNonEmptyString = (value: unknown, projectId: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw migrationError('source-unmigratable', projectId);
  }
  return value;
};

const requireSourceId = (value: unknown, projectId: string): string => {
  const sourceId = requireNonEmptyString(value, projectId);
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    throw migrationError('source-unmigratable', projectId);
  }
  return sourceId;
};

const readByteSize = (value: number | string, projectId: string): number => {
  const byteSize = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw migrationError('source-integrity-mismatch', projectId);
  }
  return byteSize;
};

const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const createSourceRef = (
  bytes: Uint8Array,
  name: string,
  mimeType: string,
  sourceId: string,
  userId: string,
  projectId: string
): MigrationSourceRef => {
  const hash = hashBytes(bytes);
  return {
    byteSize: bytes.byteLength,
    hash,
    id: sourceId,
    mimeType,
    name,
    objectPath: buildProjectSourceObjectPath(userId, projectId, sourceId, hash),
  };
};

const createContentAddressedSourceRef = (
  bytes: Uint8Array,
  name: string,
  mimeType: string,
  userId: string,
  projectId: string
): MigrationSourceRef => {
  const hash = hashBytes(bytes);
  return createSourceRef(bytes, name, mimeType, `source-${hash.slice(0, 24)}`, userId, projectId);
};

const createMigrationObject = (
  bytes: Uint8Array,
  ref: MigrationSourceRef,
  projectId: string
): ProjectSourceMigrationObject => ({
  byteSize: ref.byteSize,
  bytes,
  hash: ref.hash,
  mimeType: ref.mimeType,
  objectPath: ref.objectPath,
  projectId,
});

const createStagedSourceFile = (
  ref: MigrationSourceRef,
  position: number
): StagedProjectSourceFile => ({
  byteSize: ref.byteSize,
  mimeType: ref.mimeType,
  name: ref.name,
  objectPath: ref.objectPath,
  position,
  sourceHash: ref.hash,
  sourceId: ref.id,
});

const createBaseStage = (
  userId: string,
  projectId: string,
  ref: MigrationSourceRef,
  migrationKind: ProjectSourceMigrationKind
): ProjectSourceStorageStageRow => ({
  byte_size: ref.byteSize,
  migration_kind: migrationKind,
  mime_type: ref.mimeType,
  name: ref.name,
  object_path: ref.objectPath,
  project_id: projectId,
  source_hash: ref.hash,
  source_id: ref.id,
  source_files: [],
  staged_snapshot: null,
  user_id: userId,
});

const snapshotKey = (userId: string, projectId: string) => JSON.stringify([userId, projectId]);

const getSnapshotSource = (
  snapshot: unknown,
  projectId: string
): Record<string, unknown> | null => {
  if (!isRecord(snapshot)) {
    throw migrationError('source-unmigratable', projectId);
  }
  if (snapshot.source === null || snapshot.source === undefined) {
    return null;
  }
  if (!isRecord(snapshot.source)) {
    throw migrationError('source-unmigratable', projectId);
  }
  return snapshot.source;
};

const getPrimaryDescriptorIndex = (source: Record<string, unknown>): number | undefined => {
  if (!Array.isArray(source.sources) || !isRecord(source.file)) {
    return undefined;
  }

  const primarySourceId =
    typeof source.file.sourceId === 'string' ? source.file.sourceId : undefined;
  const index = source.sources.findIndex(
    (descriptor, descriptorIndex) =>
      isRecord(descriptor) &&
      isRecord(descriptor.file) &&
      (primarySourceId ? descriptor.id === primarySourceId : descriptorIndex === 0)
  );
  return index === -1 ? undefined : index;
};

const decodeEmbeddedBase64 = (data: unknown, projectId: string): Uint8Array => {
  if (typeof data !== 'string' || !data) {
    throw migrationError('source-unmigratable', projectId);
  }

  const compactData = data.replaceAll(/\s/gu, '');
  if (!compactData || compactData.length % 4 !== 0) {
    throw migrationError('source-unmigratable', projectId);
  }

  const bytes = Buffer.from(compactData, 'base64');
  if (Buffer.from(bytes).toString('base64') !== compactData) {
    throw migrationError('source-unmigratable', projectId);
  }
  return new Uint8Array(bytes);
};

const verifyEmbeddedBytes = (data: unknown, expectedBytes: Uint8Array, projectId: string): void => {
  if (data === undefined || data === '') {
    return;
  }

  let embeddedBytes: Uint8Array;
  try {
    embeddedBytes = decodeEmbeddedBase64(data, projectId);
  } catch {
    throw migrationError('source-integrity-mismatch', projectId);
  }
  if (
    embeddedBytes.byteLength !== expectedBytes.byteLength ||
    hashBytes(embeddedBytes) !== hashBytes(expectedBytes)
  ) {
    throw migrationError('source-integrity-mismatch', projectId);
  }
};

const readLegacyRowBytes = (row: LegacyProjectSourceRow): Uint8Array => {
  const projectId = requireNonEmptyString(row.project_id, 'unknown');
  const sourceHash = requireNonEmptyString(row.source_hash, projectId);
  if (!(row.data instanceof Uint8Array)) {
    throw migrationError('source-unmigratable', projectId);
  }

  const bytes = row.data.slice();
  const byteSize = readByteSize(row.byte_size, projectId);
  if (bytes.byteLength !== byteSize || hashBytes(bytes) !== sourceHash) {
    throw migrationError('source-integrity-mismatch', projectId);
  }
  return bytes;
};

const verifyLegacySourceMetadata = (
  file: Record<string, unknown>,
  row: LegacyProjectSourceRow,
  projectId: string
): void => {
  const legacyName = requireNonEmptyString(row.name, projectId);
  const legacyMimeType = requireNonEmptyString(row.mime_type, projectId);
  if (file.name !== legacyName || file.mimeType !== legacyMimeType) {
    throw migrationError('source-integrity-mismatch', projectId);
  }
};

interface PreparedSourceDescriptor {
  detached: Record<string, unknown>;
  object: ProjectSourceMigrationObject;
  ref: MigrationSourceRef;
  staged: StagedProjectSourceFile;
}

const prepareDescriptor = ({
  bytes,
  descriptor,
  position,
  projectId,
  userId,
}: {
  bytes: Uint8Array;
  descriptor: Record<string, unknown>;
  position: number;
  projectId: string;
  userId: string;
}): PreparedSourceDescriptor => {
  if (!isRecord(descriptor.file)) {
    throw migrationError('source-unmigratable', projectId);
  }
  const sourceId = requireSourceId(descriptor.id, projectId);
  const name = requireNonEmptyString(descriptor.file.name, projectId);
  const mimeType = requireNonEmptyString(descriptor.file.mimeType, projectId);
  const ref = createSourceRef(bytes, name, mimeType, sourceId, userId, projectId);

  return {
    detached: {
      ...descriptor,
      file: {
        ...descriptor.file,
        data: '',
        mimeType,
        name,
        sourceId: ref.id,
      },
      hash: ref.hash,
      ref,
    },
    object: createMigrationObject(bytes, ref, projectId),
    ref,
    staged: createStagedSourceFile(ref, position),
  };
};

const prepareDescriptorSetMigration = (
  row: LegacyProjectSnapshotRow,
  legacySourceRow?: LegacyProjectSourceRow
): ProjectSourceMigrationCandidate => {
  const projectId = requireNonEmptyString(row.project_id, 'unknown');
  const userId = requireNonEmptyString(row.user_id, projectId);
  const source = getSnapshotSource(row.snapshot, projectId);
  if (
    !isRecord(row.snapshot) ||
    !source ||
    !['document', 'pdf'].includes(String(source.kind)) ||
    !isRecord(source.file)
  ) {
    throw migrationError('source-unmigratable', projectId);
  }
  const primaryFile = source.file;

  const descriptors = Array.isArray(source.sources) ? source.sources : [];
  if (descriptors.length === 0) {
    const bytes = legacySourceRow
      ? readLegacyRowBytes(legacySourceRow)
      : decodeEmbeddedBase64(primaryFile.data, projectId);
    if (legacySourceRow) {
      verifyLegacySourceMetadata(primaryFile, legacySourceRow, projectId);
      verifyEmbeddedBytes(primaryFile.data, bytes, projectId);
    }
    const sourceId = legacySourceRow
      ? requireSourceId(legacySourceRow.source_id, projectId)
      : typeof primaryFile.sourceId === 'string' && primaryFile.sourceId.trim()
        ? requireSourceId(primaryFile.sourceId, projectId)
        : `source-${hashBytes(bytes).slice(0, 24)}`;
    const name = legacySourceRow
      ? requireNonEmptyString(legacySourceRow.name, projectId)
      : requireNonEmptyString(primaryFile.name, projectId);
    const mimeType = legacySourceRow
      ? requireNonEmptyString(legacySourceRow.mime_type, projectId)
      : requireNonEmptyString(primaryFile.mimeType, projectId);
    const ref = createSourceRef(bytes, name, mimeType, sourceId, userId, projectId);
    const stage = createBaseStage(
      userId,
      projectId,
      ref,
      legacySourceRow ? 'project-source-row' : 'embedded-source-set'
    );

    return {
      bytes,
      objects: [createMigrationObject(bytes, ref, projectId)],
      stage: {
        ...stage,
        source_files: [createStagedSourceFile(ref, 0)],
        staged_snapshot: {
          ...row.snapshot,
          source: {
            ...source,
            file: {
              ...primaryFile,
              data: '',
              mimeType: ref.mimeType,
              name: ref.name,
              sourceId: ref.id,
            },
            ref,
          },
        },
      },
    };
  }

  const primaryDescriptorIndex = getPrimaryDescriptorIndex(source);
  if (primaryDescriptorIndex !== 0) {
    throw migrationError('source-unmigratable', projectId);
  }

  const seenIds = new Set<string>();
  const seenPositions = new Set<number>();
  const preparedDescriptors = descriptors.map((value, index) => {
    if (!isRecord(value) || !isRecord(value.file)) {
      throw migrationError('source-unmigratable', projectId);
    }
    const sourceId = requireSourceId(value.id, projectId);
    const position = value.position;
    if (
      seenIds.has(sourceId) ||
      !Number.isSafeInteger(position) ||
      position !== index ||
      seenPositions.has(position as number)
    ) {
      throw migrationError('source-unmigratable', projectId);
    }
    seenIds.add(sourceId);
    seenPositions.add(position as number);

    const bytes =
      index === primaryDescriptorIndex && legacySourceRow
        ? readLegacyRowBytes(legacySourceRow)
        : decodeEmbeddedBase64(value.file.data, projectId);
    if (index === primaryDescriptorIndex && legacySourceRow) {
      verifyLegacySourceMetadata(primaryFile, legacySourceRow, projectId);
      verifyLegacySourceMetadata(value.file, legacySourceRow, projectId);
      verifyEmbeddedBytes(value.file.data, bytes, projectId);
      verifyEmbeddedBytes(primaryFile.data, bytes, projectId);
    }
    return prepareDescriptor({
      bytes,
      descriptor: value,
      position: position as number,
      projectId,
      userId,
    });
  });
  const primary = preparedDescriptors[primaryDescriptorIndex];
  if (!primary) {
    throw migrationError('source-unmigratable', projectId);
  }
  if (primaryFile.name !== primary.ref.name || primaryFile.mimeType !== primary.ref.mimeType) {
    throw migrationError('source-integrity-mismatch', projectId);
  }
  verifyEmbeddedBytes(primaryFile.data, primary.object.bytes, projectId);

  const stage = createBaseStage(
    userId,
    projectId,
    primary.ref,
    legacySourceRow ? 'project-source-row' : 'embedded-source-set'
  );
  return {
    bytes: primary.object.bytes,
    objects: preparedDescriptors.map(prepared => prepared.object),
    stage: {
      ...stage,
      source_files: preparedDescriptors.map(prepared => prepared.staged),
      staged_snapshot: {
        ...row.snapshot,
        source: {
          ...source,
          file: {
            ...primaryFile,
            data: '',
            mimeType: primary.ref.mimeType,
            name: primary.ref.name,
            sourceId: primary.ref.id,
          },
          ref: primary.ref,
          sources: preparedDescriptors.map(prepared => prepared.detached),
        },
      },
    },
  };
};

export const prepareLegacyProjectSourceMigration = (
  row: LegacyProjectSourceRow
): ProjectSourceMigrationCandidate => {
  const projectId = requireNonEmptyString(row.project_id, 'unknown');
  const userId = requireNonEmptyString(row.user_id, projectId);
  const sourceId = requireSourceId(row.source_id, projectId);
  const sourceHash = requireNonEmptyString(row.source_hash, projectId);
  const name = requireNonEmptyString(row.name, projectId);
  const mimeType = requireNonEmptyString(row.mime_type, projectId);
  const bytes = readLegacyRowBytes(row);
  const byteSize = bytes.byteLength;
  const ref = createSourceRef(bytes, name, mimeType, sourceId, userId, projectId);

  return {
    bytes,
    objects: [createMigrationObject(bytes, ref, projectId)],
    stage: {
      byte_size: byteSize,
      migration_kind: 'project-source-row',
      mime_type: mimeType,
      name,
      object_path: ref.objectPath,
      project_id: projectId,
      source_hash: sourceHash,
      source_id: sourceId,
      source_files: [createStagedSourceFile(ref, 0)],
      staged_snapshot: null,
      user_id: userId,
    },
  };
};

export const prepareHistoricalCodebaseMigration = (
  row: LegacyProjectSnapshotRow
): ProjectSourceMigrationCandidate => {
  const projectId = requireNonEmptyString(row.project_id, 'unknown');
  const userId = requireNonEmptyString(row.user_id, projectId);
  const source = getSnapshotSource(row.snapshot, projectId);
  if (
    !isRecord(row.snapshot) ||
    !source ||
    source.kind !== 'codebase-bundle' ||
    typeof source.aggregatedText !== 'string' ||
    !isAbsentOrEmptyArray(source.files) ||
    !isAbsentOrEmptyArray(source.sources)
  ) {
    throw migrationError('source-unmigratable', projectId);
  }

  const originalName =
    typeof source.name === 'string' && source.name.trim() ? source.name : 'historical-source';
  const documentName = originalName.toLowerCase().endsWith('.txt')
    ? originalName
    : `${originalName}.txt`;
  const bytes = new TextEncoder().encode(source.aggregatedText);
  const ref = createContentAddressedSourceRef(
    bytes,
    documentName,
    HISTORICAL_SOURCE_MIME_TYPE,
    userId,
    projectId
  );
  const stage = createBaseStage(userId, projectId, ref, 'historical-codebase');

  return {
    bytes,
    objects: [createMigrationObject(bytes, ref, projectId)],
    stage: {
      ...stage,
      source_files: [createStagedSourceFile(ref, 0)],
      staged_snapshot: {
        ...row.snapshot,
        sourceKind: 'document',
        source: {
          file: {
            data: '',
            mimeType: ref.mimeType,
            name: ref.name,
            sourceId: ref.id,
          },
          kind: 'document',
          ref,
        },
      },
    },
  };
};

export const prepareEmbeddedSourceSetMigration = (
  row: LegacyProjectSnapshotRow
): ProjectSourceMigrationCandidate => prepareDescriptorSetMigration(row);

const compareCandidates = (
  left: ProjectSourceMigrationCandidate,
  right: ProjectSourceMigrationCandidate
) => {
  const leftKey = snapshotKey(left.stage.user_id, left.stage.project_id);
  const rightKey = snapshotKey(right.stage.user_id, right.stage.project_id);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

export const planProjectSourceMigrations = (
  sourceRows: LegacyProjectSourceRow[],
  snapshotRows: LegacyProjectSnapshotRow[]
): ProjectSourceMigrationCandidate[] => {
  const snapshotsByKey = new Map<string, LegacyProjectSnapshotRow>();
  for (const snapshotRow of snapshotRows) {
    const key = snapshotKey(snapshotRow.user_id, snapshotRow.project_id);
    if (snapshotsByKey.has(key)) {
      throw migrationError('source-unmigratable', snapshotRow.project_id);
    }
    snapshotsByKey.set(key, snapshotRow);
  }

  const migratedKeys = new Set<string>();
  const candidates: ProjectSourceMigrationCandidate[] = [];
  for (const sourceRow of sourceRows) {
    const key = snapshotKey(sourceRow.user_id, sourceRow.project_id);
    if (migratedKeys.has(key)) {
      throw migrationError('source-unmigratable', sourceRow.project_id);
    }
    const snapshotRow = snapshotsByKey.get(key);
    if (!snapshotRow) {
      throw migrationError('source-unmigratable', sourceRow.project_id);
    }

    const source = getSnapshotSource(snapshotRow.snapshot, sourceRow.project_id);
    if (source?.kind === 'codebase-bundle') {
      throw migrationError('source-unmigratable', sourceRow.project_id);
    }
    if (source && !['document', 'pdf'].includes(String(source.kind))) {
      throw migrationError('source-unmigratable', sourceRow.project_id);
    }

    const candidate = source
      ? prepareDescriptorSetMigration(snapshotRow, sourceRow)
      : prepareLegacyProjectSourceMigration(sourceRow);
    migratedKeys.add(key);
    candidates.push(candidate);
  }

  for (const snapshotRow of snapshotRows) {
    const key = snapshotKey(snapshotRow.user_id, snapshotRow.project_id);
    if (migratedKeys.has(key)) {
      continue;
    }

    const source = getSnapshotSource(snapshotRow.snapshot, snapshotRow.project_id);
    if (!source) {
      continue;
    }
    if (source.kind === 'codebase-bundle') {
      candidates.push(prepareHistoricalCodebaseMigration(snapshotRow));
      continue;
    }
    if (source.kind === 'pdf' || source.kind === 'document') {
      candidates.push(prepareEmbeddedSourceSetMigration(snapshotRow));
      continue;
    }
    throw migrationError('source-unmigratable', snapshotRow.project_id);
  }

  const sortedCandidates = candidates.sort(compareCandidates);
  const objectPaths = new Set<string>();
  for (const candidate of sortedCandidates) {
    for (const object of candidate.objects) {
      if (objectPaths.has(object.objectPath)) {
        throw migrationError('source-unmigratable', candidate.stage.project_id);
      }
      objectPaths.add(object.objectPath);
    }
  }
  return sortedCandidates;
};

const normalizeStorageConfig = ({
  serviceRoleKey,
  supabaseUrl,
}: EnsurePrivateProjectSourceBucketConfig) => {
  const normalizedServiceRoleKey = serviceRoleKey.trim();
  const normalizedSupabaseUrl = supabaseUrl.trim().replace(/\/+$/u, '');
  let url: URL;

  try {
    url = new URL(normalizedSupabaseUrl);
  } catch {
    throw migrationError('configuration-invalid');
  }
  if (
    !normalizedServiceRoleKey ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.href.replace(/\/$/u, '') !== normalizedSupabaseUrl
  ) {
    throw migrationError('configuration-invalid');
  }

  return {
    serviceRoleKey: normalizedServiceRoleKey,
    supabaseUrl: normalizedSupabaseUrl,
  };
};

const storageRequest = async (
  fetcher: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Response> => {
  try {
    return await fetcher(url, init);
  } catch {
    throw migrationError('bucket-request-failed');
  }
};

const privateBucketExists = async (
  fetcher: typeof fetch,
  bucketUrl: string,
  headers: Record<string, string>
): Promise<boolean> => {
  const response = await storageRequest(fetcher, bucketUrl, {
    headers,
    method: 'GET',
  });
  if (response.status === 404) {
    return false;
  }
  if (response.status === 400) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      throw migrationError('bucket-request-failed');
    }
    if (
      isRecord(errorBody) &&
      String(errorBody.statusCode) === '404' &&
      errorBody.message === 'Bucket not found'
    ) {
      return false;
    }
    throw migrationError('bucket-request-failed');
  }
  if (!response.ok) {
    throw migrationError('bucket-request-failed');
  }

  let bucket: unknown;
  try {
    bucket = await response.json();
  } catch {
    throw migrationError('bucket-request-failed');
  }
  if (!isRecord(bucket) || bucket.id !== PROJECT_SOURCE_BUCKET || bucket.public !== false) {
    throw migrationError('bucket-not-private');
  }
  return true;
};

export const ensurePrivateProjectSourceBucket = async (
  config: EnsurePrivateProjectSourceBucketConfig
): Promise<void> => {
  const { serviceRoleKey, supabaseUrl } = normalizeStorageConfig(config);
  const fetcher = config.fetcher ?? fetch;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  const bucketUrl = `${supabaseUrl}/storage/v1/bucket/${PROJECT_SOURCE_BUCKET}`;
  if (await privateBucketExists(fetcher, bucketUrl, headers)) {
    return;
  }

  const createResponse = await storageRequest(fetcher, `${supabaseUrl}/storage/v1/bucket`, {
    body: JSON.stringify({
      id: PROJECT_SOURCE_BUCKET,
      name: PROJECT_SOURCE_BUCKET,
      public: false,
    }),
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  if (!createResponse.ok && createResponse.status !== 409) {
    throw migrationError('bucket-request-failed');
  }
  if (!(await privateBucketExists(fetcher, bucketUrl, headers))) {
    throw migrationError('bucket-request-failed');
  }
};

const uploadImmutableObject = async (
  storage: ProjectSourceMigrationStorage,
  object: ProjectSourceMigrationObject
): Promise<'uploaded' | 'verified-existing'> => {
  try {
    await storage.upload(object.objectPath, object.bytes, object.mimeType);
    return 'uploaded';
  } catch (error) {
    if (
      !(error instanceof ProjectSourceStorageError) ||
      (error.status !== 400 && error.status !== 409)
    ) {
      throw migrationError('storage-request-failed', object.projectId);
    }
  }

  try {
    const existingBytes = await storage.download(object.objectPath, {
      byteSize: object.byteSize,
      hash: object.hash,
    });
    verifyProjectSourceBytes(existingBytes, {
      byteSize: object.byteSize,
      hash: object.hash,
    });
  } catch {
    throw migrationError('storage-collision', object.projectId);
  }
  return 'verified-existing';
};

export const uploadImmutableProjectSource = async (
  storage: ProjectSourceMigrationStorage,
  candidate: ProjectSourceMigrationCandidate
): Promise<{ uploaded: number; verifiedExisting: number }> => {
  let uploaded = 0;
  let verifiedExisting = 0;
  for (const object of candidate.objects) {
    const result = await uploadImmutableObject(storage, object);
    if (result === 'uploaded') {
      uploaded += 1;
    } else {
      verifiedExisting += 1;
    }
  }
  return { uploaded, verifiedExisting };
};

export const migrateProjectSources = async ({
  ensureBucket,
  repository,
  storage,
}: ProjectSourceMigrationDependencies): Promise<{
  staged: number;
  uploaded: number;
  verifiedExisting: number;
}> => {
  let schemaState: ProjectSourceSchemaState;
  try {
    schemaState = await repository.getSchemaState();
  } catch {
    throw migrationError('database-failed');
  }
  if (schemaState !== 'legacy') {
    await ensureBucket();
    return { staged: 0, uploaded: 0, verifiedExisting: 0 };
  }

  let sourceRows: LegacyProjectSourceRow[];
  let snapshotRows: LegacyProjectSnapshotRow[];
  try {
    await repository.ensureStageTable();
    [sourceRows, snapshotRows] = await Promise.all([
      repository.listLegacyProjectSources(),
      repository.listProjectSnapshots(),
    ]);
  } catch {
    throw migrationError('database-failed');
  }

  const candidates = planProjectSourceMigrations(sourceRows, snapshotRows);
  await ensureBucket();

  let uploaded = 0;
  let verifiedExisting = 0;
  for (const candidate of candidates) {
    const uploadResult = await uploadImmutableProjectSource(storage, candidate);
    uploaded += uploadResult.uploaded;
    verifiedExisting += uploadResult.verifiedExisting;
  }

  try {
    await repository.replaceStage(candidates.map(candidate => candidate.stage));
  } catch {
    throw migrationError('database-failed');
  }

  return {
    staged: candidates.length,
    uploaded,
    verifiedExisting,
  };
};

type PostgresSql = ReturnType<typeof postgres>;
type PostgresMutationSql = PostgresSql | postgres.TransactionSql;

export class PostgresProjectSourceMigrationRepository implements ProjectSourceMigrationRepository {
  constructor(private readonly sql: PostgresSql) {}

  async getSchemaState(): Promise<ProjectSourceSchemaState> {
    const [inspection] = await this.sql<ProjectSourceSchemaInspection[]>`
      select
        exists (
          select 1
          from information_schema.tables
          where table_schema = 'public'
            and table_name = 'project_snapshots'
        ) as has_project_snapshots,
        exists (
          select 1
          from information_schema.tables
          where table_schema = 'public'
            and table_name = 'project_sources'
        ) as has_project_sources,
        exists (
          select 1
          from information_schema.tables
          where table_schema = 'public'
            and table_name = 'project_source_files'
        ) as has_project_source_files,
        exists (
          select 1
          from information_schema.tables
          where table_schema = 'public'
            and table_name = 'project_source_entries'
        ) as has_project_source_entries,
        exists (
          select 1
          from information_schema.tables
          where table_schema = 'public'
            and table_name = 'project_source_deletions'
        ) as has_project_source_deletions,
        exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'project_sources'
            and column_name = 'data'
        ) as has_data,
        exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'project_sources'
            and column_name = 'source_kind'
        ) as has_source_kind
    `;
    if (!inspection) {
      throw migrationError('database-failed');
    }
    return classifyProjectSourceSchemaState(inspection);
  }

  async ensureStageTable(): Promise<void> {
    await this.sql.unsafe(PROJECT_SOURCE_STORAGE_STAGE_DDL);
  }

  async listLegacyProjectSources(): Promise<LegacyProjectSourceRow[]> {
    return this.sql<LegacyProjectSourceRow[]>`
      select
        user_id::text,
        project_id,
        source_id,
        source_hash,
        name,
        mime_type,
        byte_size,
        data
      from public.project_sources
      order by user_id, project_id
    `;
  }

  async listProjectSnapshots(): Promise<LegacyProjectSnapshotRow[]> {
    return this.sql<LegacyProjectSnapshotRow[]>`
      select user_id::text, id as project_id, snapshot
      from public.project_snapshots
      order by user_id, id
    `;
  }

  async replaceStage(rows: ProjectSourceStorageStageRow[]): Promise<void> {
    await this.sql.begin(async sql => {
      await sql`delete from public.project_source_storage_stage`;
      for (const row of rows) {
        await this.insertStage(sql, row);
      }
    });
  }

  private async insertStage(
    sql: PostgresMutationSql,
    row: ProjectSourceStorageStageRow
  ): Promise<void> {
    const stagedSnapshot =
      row.staged_snapshot === null ? null : sql.json(row.staged_snapshot as postgres.JSONValue);
    const sourceFiles = sql.json(row.source_files as unknown as postgres.JSONValue);

    await sql`
      insert into public.project_source_storage_stage
        (
          user_id,
          project_id,
          migration_kind,
          source_id,
          source_hash,
          name,
          mime_type,
          byte_size,
          object_path,
          staged_snapshot,
          source_files,
          staged_at
        )
      values
        (
          ${row.user_id},
          ${row.project_id},
          ${row.migration_kind},
          ${row.source_id},
          ${row.source_hash},
          ${row.name},
          ${row.mime_type},
          ${row.byte_size},
          ${row.object_path},
          ${stagedSnapshot},
          ${sourceFiles},
          now()
        )
      on conflict (user_id, project_id) do update set
        migration_kind = excluded.migration_kind,
        source_id = excluded.source_id,
        source_hash = excluded.source_hash,
        name = excluded.name,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        object_path = excluded.object_path,
        staged_snapshot = excluded.staged_snapshot,
        source_files = excluded.source_files,
        staged_at = now()
    `;
  }
}

const runCli = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL?.trim() || '';
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
  if (!databaseUrl || !supabaseUrl || !serviceRoleKey) {
    throw migrationError('configuration-invalid');
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const repository = new PostgresProjectSourceMigrationRepository(sql);
    const storage = new SupabaseProjectSourceStorage({
      serviceRoleKey,
      supabaseUrl,
    });
    const result = await migrateProjectSources({
      ensureBucket: () =>
        ensurePrivateProjectSourceBucket({
          serviceRoleKey,
          supabaseUrl,
        }),
      repository,
      storage,
    });
    console.info('[Project source migration] Staging complete.', result);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

if (import.meta.main) {
  runCli().catch(error => {
    const diagnostic =
      error instanceof ProjectSourceDataMigrationError ? error : migrationError('database-failed');
    console.error('[Project source migration] Failed.', {
      code: diagnostic.code,
      message: diagnostic.message,
      projectId: diagnostic.projectId,
    });
    process.exitCode = 1;
  });
}
