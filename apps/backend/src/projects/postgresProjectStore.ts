import { createHash } from 'node:crypto';

import {
  buildOrderedSiblingItems,
  collectFolderDescendantIds,
  insertMovedSiblingItems,
  resolveNextFolderOrder,
  resolveNextPlacementOrder,
  SIBLING_ORDER_STEP,
  type SiblingItem,
} from '@shared/libraryOrdering';
import postgres from 'postgres';
import { createEntityId } from '../utils/ids.js';
import { timestampIso } from '../utils/time.js';
import { isRecord } from '../utils/validation.js';
import { resolveAvailableFolderName } from './folderNames.js';
import { buildProjectMeta, normalizeProjectSnapshot } from './projectMeta.js';
import { applyProjectPatch } from './projectPatch.js';
import { ProjectRevisionConflictError } from './projectRevision.js';
import {
  attachProjectSource,
  attachProjectSources,
  buildProjectSourceEntryObjectPath,
  buildProjectSourceObjectPath,
  detachProjectSource,
  detachProjectSources,
  prepareProjectSource,
  prepareProjectSourceBytes,
  readEmbeddedProjectSource,
  readEmbeddedProjectSources,
} from './projectSource.js';
import { ProjectSourceStorageError, SupabaseProjectSourceStorage } from './projectSourceStorage.js';
import {
  PROJECT_SOURCE_ARCHIVE_LIMITS,
  PROJECT_SOURCE_ARCHIVE_MAX_COMPRESSED_BYTES,
  streamSourceArchive,
} from './sourceArchive.js';
import type {
  LibraryFolder,
  LibraryPlacement,
  ProjectCoverFile,
  ProjectCoverWriteOptions,
  ProjectExportData,
  ProjectId,
  ProjectImportDiagnostic,
  ProjectImportDiagnosticInput,
  ProjectPatch,
  ProjectSaveOptions,
  ProjectSaveResult,
  ProjectSnapshot,
  ProjectSnapshotWithRevision,
  ProjectSourceArchiveIndex,
  ProjectSourceFile,
  ProjectSourceRef,
  ProjectStore,
  ProjectWriteOptions,
  SavedProjectMeta,
  StoredProjectSourceFile,
} from './types.js';

type PostgresSql = ReturnType<typeof postgres>;
type PostgresMutationSql = PostgresSql | postgres.TransactionSql;
type ProjectTransactionSql = postgres.ReservedSql | postgres.TransactionSql;
type LibraryItem = SiblingItem;

interface ProjectMetaRow {
  meta: SavedProjectMeta;
  revision: number;
}

interface ProjectImportDiagnosticRow {
  code: string;
  correlation_id: string;
  created_at: Date | string;
  file_bytes: number | string | null;
  id: number | string;
  limit_bytes: number | string | null;
  project_count: number | null;
  project_index: number | null;
  stage: string;
  user_id: string;
}

interface ProjectSnapshotRow {
  document_index: unknown | null;
  snapshot: Omit<ProjectSnapshot, 'documentIndex'>;
}

interface ProjectSnapshotWithRevisionRow extends ProjectSnapshotRow {
  revision: number | string;
}

interface ProjectSourceRow {
  byte_size: number | string;
  mime_type: string;
  name: string;
  object_path: string;
  source_hash: string;
}

interface ProjectSourceMetadataRow extends ProjectSourceRow {
  source_id: string;
  source_kind: 'archive' | 'file';
}

interface ProjectSourceFileRow extends ProjectSourceRow {
  position: number;
  source_id: string;
}

interface ProjectCoverRow {
  data: Uint8Array;
  mime_type: string;
  name: string;
}

interface ProjectSourceObjectPathRow {
  object_path: string;
}

interface ProjectSourceArchiveEntryRow {
  byte_size: number | string | null;
  content_kind: 'binary' | 'text' | null;
  kind: 'directory' | 'file';
  path: string;
  preview: string | null;
  source_hash: string | null;
}

interface ProjectSourceArchiveIndexRow {
  archive_source_hash: string;
  archive_source_id: string;
  byte_size: number | string | null;
  content_kind: 'binary' | 'text' | null;
  kind: 'directory' | 'file' | null;
  path: string | null;
  preview: string | null;
  source_hash: string | null;
  source_kind: 'archive' | 'file';
}

interface ProjectSourceArchiveStoredFileRow {
  byte_size: number;
  content_kind: 'binary' | 'text';
  object_path: string;
  source_hash: string;
}

interface ProjectSourceArchiveEntryMetadata {
  byte_size: number | null;
  content_kind: 'binary' | 'text' | null;
  kind: 'directory' | 'file';
  object_path: string | null;
  path: string;
  preview: string | null;
  source_hash: string | null;
}

interface PreparedProjectSource {
  archiveBytes?: Uint8Array;
  archiveEntries: ProjectSourceArchiveEntryMetadata[];
  files: Array<{ position: number; ref: ProjectSourceRef }>;
  objects: Array<{
    bytes: Uint8Array;
    mimeType: string;
    path: string;
  }>;
  primaryRef: ProjectSourceRef;
  sourceKind: 'archive' | 'file';
}

interface ProjectSourceObjectStorage {
  delete(path: string): Promise<void>;
  download(path: string, expected: { byteSize: number; hash: string }): Promise<Uint8Array>;
  downloadRange(
    path: string,
    expectedByteSize: number,
    start: number,
    endExclusive: number
  ): Promise<Uint8Array>;
  upload(path: string, bytes: Uint8Array, mimeType: string): Promise<void>;
}

interface FolderRow {
  folder: LibraryFolder;
}

interface PlacementRow {
  placement: LibraryPlacement;
}

const createFolderId = (): string => createEntityId('folder');
const toPostgresJson = (value: unknown): postgres.JSONValue => value as postgres.JSONValue;
const ZIP_SOURCE_MIME_TYPES = new Set(['application/x-zip-compressed', 'application/zip']);
const SOURCE_DELETION_DRAIN_LIMIT = 100;
const SOURCE_UPLOAD_MAX_CONCURRENCY = 4;
const SOURCE_UPLOAD_MAX_IN_FLIGHT_BYTES = 64_000_000;
const SOURCE_ENTRY_PATH_SEGMENT = '/entries/';
const SOURCE_ORIGINAL_PATH_SUFFIX = '/original';
const PROJECT_IMPORT_DIAGNOSTIC_RETENTION_DAYS = 30;
const PROJECT_IMPORT_DIAGNOSTIC_LIST_LIMIT = 200;

const compareLockKeysByCodeUnit = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const stripProjectRevision = (meta: SavedProjectMeta): Omit<SavedProjectMeta, 'revision'> => {
  const { revision: _revision, ...storedMeta } = meta;
  return storedMeta;
};

const mergeProjectMetaRow = (row: ProjectMetaRow): SavedProjectMeta => ({
  ...row.meta,
  revision: Number(row.revision),
});

const toEpochMillis = (value: string | undefined): number => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const splitSnapshot = (snapshot: ProjectSnapshot) => {
  const { documentIndex, ...snapshotWithoutDocumentIndex } = snapshot;
  return { documentIndex: documentIndex ?? null, snapshotWithoutDocumentIndex };
};

const mergeSnapshot = (row: ProjectSnapshotRow): ProjectSnapshot =>
  normalizeProjectSnapshot({
    ...row.snapshot,
    ...(row.document_index === null ? {} : { documentIndex: row.document_index }),
  });

export class PostgresProjectStore implements ProjectStore {
  private readonly sql: PostgresSql;
  private sourceDeletionDrainPromise: Promise<void> | undefined;
  private sourceStorage: ProjectSourceObjectStorage | undefined;

  constructor(
    databaseUrl = process.env.DATABASE_URL?.trim(),
    sqlClient?: PostgresSql,
    sourceStorage?: ProjectSourceObjectStorage
  ) {
    if (!databaseUrl && !sqlClient) {
      throw new Error('DATABASE_URL is required for project storage.');
    }

    this.sql = sqlClient ?? postgres(databaseUrl as string, { max: 10 });
    this.sourceStorage = sourceStorage;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async listProjects(userId: string): Promise<SavedProjectMeta[]> {
    this.startQueuedSourceDeletionDrain();
    const rows = await this.sql<ProjectMetaRow[]>`
      select meta, revision
      from public.projects
      where user_id = ${userId}
      order by last_opened_at desc nulls last, updated_at desc, id asc
    `;

    return rows
      .map(mergeProjectMetaRow)
      .sort((left, right) => toEpochMillis(right.lastOpenedAt) - toEpochMillis(left.lastOpenedAt));
  }

  async listProjectImportDiagnostics(correlationId?: string): Promise<ProjectImportDiagnostic[]> {
    await this.deleteExpiredProjectImportDiagnostics();
    const rows = await this.sql<ProjectImportDiagnosticRow[]>`
      select
        id,
        user_id,
        correlation_id,
        code,
        stage,
        file_bytes,
        limit_bytes,
        project_count,
        project_index,
        created_at
      from public.project_import_diagnostics
      where created_at >= now() - ${PROJECT_IMPORT_DIAGNOSTIC_RETENTION_DAYS} * interval '1 day'
        and correlation_id = coalesce(${correlationId ?? null}::uuid, correlation_id)
      order by created_at desc, id desc
      limit ${PROJECT_IMPORT_DIAGNOSTIC_LIST_LIMIT}
    `;

    return rows.map(row => ({
      id: Number(row.id),
      userId: row.user_id,
      correlationId: row.correlation_id,
      code: row.code,
      stage: row.stage,
      ...(row.file_bytes === null ? {} : { fileBytes: Number(row.file_bytes) }),
      ...(row.limit_bytes === null ? {} : { limitBytes: Number(row.limit_bytes) }),
      ...(row.project_count === null ? {} : { projectCount: row.project_count }),
      ...(row.project_index === null ? {} : { projectIndex: row.project_index }),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async recordProjectImportDiagnostic(
    userId: string,
    diagnostic: ProjectImportDiagnosticInput
  ): Promise<void> {
    await this.sql.begin(async sql => {
      await this.deleteExpiredProjectImportDiagnostics(sql);
      await sql`
        insert into public.project_import_diagnostics (
          user_id,
          correlation_id,
          code,
          stage,
          file_bytes,
          limit_bytes,
          project_count,
          project_index
        ) values (
          ${userId},
          ${diagnostic.correlationId},
          ${diagnostic.code},
          ${diagnostic.stage},
          ${diagnostic.fileBytes ?? null},
          ${diagnostic.limitBytes ?? null},
          ${diagnostic.projectCount ?? null},
          ${diagnostic.projectIndex ?? null}
        )
      `;
    });
  }

  async loadProject(userId: string, id: ProjectId): Promise<ProjectSnapshot | null> {
    const rows = await this.sql<ProjectSnapshotRow[]>`
      select snapshot, document_index
      from public.project_snapshots
      where user_id = ${userId} and id = ${id}
      limit 1
    `;

    if (!rows[0]) {
      return null;
    }

    return mergeSnapshot(rows[0]);
  }

  async loadProjectWithRevision(
    userId: string,
    id: ProjectId
  ): Promise<ProjectSnapshotWithRevision | null> {
    const rows = await this.sql<ProjectSnapshotWithRevisionRow[]>`
      select project_snapshots.snapshot, project_snapshots.document_index, projects.revision
      from public.project_snapshots
      join public.projects
        on projects.user_id = project_snapshots.user_id and projects.id = project_snapshots.id
      where project_snapshots.user_id = ${userId} and project_snapshots.id = ${id}
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { revision: Number(row.revision), snapshot: mergeSnapshot(row) };
  }

  async loadProjectSource(userId: string, id: ProjectId): Promise<ProjectSourceFile | null> {
    const rows = await this.sql<ProjectSourceRow[]>`
      select name, mime_type, source_hash, byte_size, object_path
      from public.project_sources
      where user_id = ${userId} and project_id = ${id}
      limit 1
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }

    const bytes = await this.getSourceStorage().download(row.object_path, {
      byteSize: Number(row.byte_size),
      hash: row.source_hash,
    });
    return {
      name: row.name,
      mimeType: row.mime_type,
      data: Buffer.from(bytes).toString('base64'),
    };
  }

  async loadProjectSources(userId: string, id: ProjectId): Promise<StoredProjectSourceFile[]> {
    const rows = await this.sql<ProjectSourceFileRow[]>`
      select source_id, source_hash, name, mime_type, byte_size, object_path, position
      from public.project_source_files
      where user_id = ${userId} and project_id = ${id}
      order by position
    `;
    return Promise.all(
      rows.map(async row => {
        const bytes = await this.getSourceStorage().download(row.object_path, {
          byteSize: Number(row.byte_size),
          hash: row.source_hash,
        });
        return {
          file: {
            data: Buffer.from(bytes).toString('base64'),
            mimeType: row.mime_type,
            name: row.name,
            sourceId: row.source_id,
          },
          ref: {
            byteSize: Number(row.byte_size),
            hash: row.source_hash,
            id: row.source_id,
            mimeType: row.mime_type,
            name: row.name,
            objectPath: row.object_path,
          },
        };
      })
    );
  }

  async loadProjectSourceArchiveIndex(
    userId: string,
    id: ProjectId
  ): Promise<ProjectSourceArchiveIndex | null> {
    const rows = await this.sql<ProjectSourceArchiveIndexRow[]>`
      select
        source.source_id as archive_source_id,
        source.source_hash as archive_source_hash,
        source.source_kind,
        entry.path,
        entry.kind,
        entry.content_kind,
        entry.source_hash,
        entry.byte_size,
        entry.preview
      from public.project_sources source
      left join public.project_source_entries entry
        on entry.user_id = source.user_id and entry.project_id = source.project_id
      where source.user_id = ${userId} and source.project_id = ${id}
      order by entry.path
    `;
    const source = rows[0];
    if (!source || source.source_kind !== 'archive') {
      return null;
    }

    return {
      entries: rows.flatMap(row => {
        if (row.path === null || row.kind === null) {
          return [];
        }
        return [
          row.kind === 'directory'
            ? {
                kind: row.kind,
                path: row.path,
              }
            : {
                byteSize: Number(row.byte_size),
                contentKind: row.content_kind as 'binary' | 'text',
                hash: row.source_hash as string,
                kind: row.kind,
                path: row.path,
                ...(row.preview === null ? {} : { preview: row.preview }),
              },
        ];
      }),
      version: {
        sourceHash: source.archive_source_hash,
        sourceId: source.archive_source_id,
      },
    };
  }

  async loadProjectSourceArchiveEntry(
    userId: string,
    id: ProjectId,
    path: string,
    version: ProjectSourceArchiveIndex['version']
  ): Promise<Uint8Array | null> {
    const row = await this.loadProjectSourceArchiveFileRow(userId, id, path, version);
    if (!row) {
      return null;
    }
    return this.getSourceStorage().download(row.object_path, {
      byteSize: Number(row.byte_size),
      hash: row.source_hash,
    });
  }

  async loadProjectSourceArchiveEntryRange(
    userId: string,
    id: ProjectId,
    path: string,
    version: ProjectSourceArchiveIndex['version'],
    start: number,
    endExclusive: number
  ): Promise<Uint8Array | null> {
    const row = await this.loadProjectSourceArchiveFileRow(userId, id, path, version);
    if (!row) {
      return null;
    }
    return this.getSourceStorage().downloadRange(
      row.object_path,
      Number(row.byte_size),
      start,
      endExclusive
    );
  }

  private async loadProjectSourceArchiveFileRow(
    userId: string,
    id: ProjectId,
    path: string,
    version: ProjectSourceArchiveIndex['version']
  ): Promise<ProjectSourceArchiveStoredFileRow | null> {
    const rows = await this.sql<ProjectSourceArchiveStoredFileRow[]>`
      select entry.content_kind, entry.source_hash, entry.byte_size, entry.object_path
      from public.project_source_entries entry
      join public.project_sources source
        on source.user_id = entry.user_id and source.project_id = entry.project_id
      where entry.user_id = ${userId}
        and entry.project_id = ${id}
        and entry.path = ${path}
        and entry.kind = 'file'
        and source.source_id = ${version.sourceId}
        and source.source_hash = ${version.sourceHash}
      limit 1
    `;
    return rows[0] ?? null;
  }

  async loadProjectCover(userId: string, id: ProjectId): Promise<ProjectCoverFile | null> {
    const rows = await this.sql<ProjectCoverRow[]>`
      select name, mime_type, data
      from public.project_covers
      where user_id = ${userId} and project_id = ${id}
      limit 1
    `;
    const row = rows[0];
    return row
      ? { name: row.name, mimeType: row.mime_type, data: Buffer.from(row.data).toString('base64') }
      : null;
  }

  async saveProjectCover(
    userId: string,
    id: ProjectId,
    cover: ProjectCoverFile,
    { expectedRevision }: ProjectCoverWriteOptions = {}
  ): Promise<boolean> {
    const bytes = Buffer.from(cover.data, 'base64');
    const rows = await this.sql<Array<{ project_id: string }>>`
      insert into public.project_covers
        (user_id, project_id, name, mime_type, byte_size, data, updated_at)
      select
        ${userId}, ${id}, ${cover.name}, ${cover.mimeType}, ${bytes.byteLength}, ${bytes}, now()
      from public.projects
      where user_id = ${userId}
        and id = ${id}
        and (${expectedRevision ?? null}::bigint is null or revision = ${expectedRevision ?? null})
      for key share
      on conflict (user_id, project_id) do update set
        name = excluded.name,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        data = excluded.data,
        updated_at = excluded.updated_at
      returning project_id
    `;
    return Boolean(rows[0]);
  }

  async loadProjectsById(userId: string, ids: ProjectId[]): Promise<ProjectSnapshot[]> {
    const snapshots = await Promise.all(ids.map(id => this.loadProject(userId, id)));
    return snapshots.filter((snapshot): snapshot is ProjectSnapshot => Boolean(snapshot));
  }

  async saveProject(
    userId: string,
    data: ProjectSnapshot,
    { expectedRevision, sourceFile }: ProjectSaveOptions = {}
  ): Promise<ProjectSaveResult> {
    let snapshot = normalizeProjectSnapshot(data);
    const existingMeta = await this.readProjectMeta(userId, snapshot.id);
    if (expectedRevision !== undefined && existingMeta?.revision !== expectedRevision) {
      throw new ProjectRevisionConflictError();
    }
    const existingSnapshot = await this.loadProject(userId, snapshot.id);
    if (existingSnapshot?.source) {
      snapshot = await this.detachUnchangedEmbeddedSource(userId, snapshot, existingSnapshot);
    }

    if (
      expectedRevision === undefined &&
      existingSnapshot &&
      toEpochMillis(existingSnapshot.updatedAt) > toEpochMillis(snapshot.updatedAt)
    ) {
      const meta = buildProjectMeta(existingSnapshot, existingMeta, {
        touchedAt: existingMeta?.updatedAt || existingSnapshot.updatedAt,
      });
      return {
        meta: await this.writeProjectMeta(userId, meta),
        snapshot: existingSnapshot,
      };
    }

    const sourceWrite = await this.prepareProjectSourceWrite(userId, snapshot, sourceFile);
    if (sourceWrite) {
      snapshot = sourceWrite.snapshot;
    } else if (snapshot.source != null && existingSnapshot?.source == null) {
      throw new Error('Detached project source has no stored metadata.');
    }
    const uploadedObjectPaths: string[] = [];
    const lockedObjectPaths: string[] = [];
    let replacedObjectPaths: string[] = [];
    let sourceUploadSql: postgres.ReservedSql | undefined;
    let savedMeta: SavedProjectMeta | undefined;
    let saveError: unknown;

    try {
      if (sourceWrite) {
        sourceUploadSql = await this.sql.reserve();
        await this.uploadPreparedProjectSource(
          sourceUploadSql,
          this.getSourceStorage(),
          userId,
          snapshot.id,
          sourceWrite.prepared,
          uploadedObjectPaths,
          lockedObjectPaths
        );
        snapshot = this.applyPreparedArchiveIndex(snapshot, sourceWrite.prepared);
      }

      const persistProject = async (sql: ProjectTransactionSql) => {
        if (sourceWrite && lockedObjectPaths.length === 0) {
          throw new Error('Project source upload locks are missing.');
        }

        if (existingMeta) {
          await sql`
            select id
            from public.projects
            where user_id = ${userId} and id = ${snapshot.id}
            for update
          `;
        }
        const snapshotToPersist =
          !sourceWrite && snapshot.source != null
            ? await this.canonicalizeDetachedProjectSource(sql, userId, snapshot)
            : snapshot;
        const meta = buildProjectMeta(snapshotToPersist, existingMeta);
        const serializedMeta = sql.json(toPostgresJson(stripProjectRevision(meta)));
        const { documentIndex, snapshotWithoutDocumentIndex } = splitSnapshot(snapshotToPersist);
        let revisionRows: ProjectMetaRow[];
        if (existingMeta) {
          revisionRows =
            expectedRevision === undefined
              ? await sql<ProjectMetaRow[]>`
                update public.projects
                set meta = jsonb_set(
                      ${serializedMeta},
                      '{isFavorite}',
                      coalesce(meta -> 'isFavorite', 'false'::jsonb),
                      true
                    ),
                    updated_at = ${meta.updatedAt},
                    last_opened_at = ${meta.lastOpenedAt},
                    server_updated_at = now(),
                    revision = revision + 1
                where user_id = ${userId} and id = ${snapshot.id}
                returning meta, revision
              `
              : await sql<ProjectMetaRow[]>`
                update public.projects
                set meta = jsonb_set(
                      ${serializedMeta},
                      '{isFavorite}',
                      coalesce(meta -> 'isFavorite', 'false'::jsonb),
                      true
                    ),
                    updated_at = ${meta.updatedAt},
                    last_opened_at = ${meta.lastOpenedAt},
                    server_updated_at = now(),
                    revision = revision + 1
                where user_id = ${userId} and id = ${snapshot.id} and revision = ${expectedRevision}
                returning meta, revision
              `;
          if (!revisionRows[0]) {
            throw new ProjectRevisionConflictError();
          }
        } else {
          if (expectedRevision !== undefined) {
            throw new ProjectRevisionConflictError();
          }
          revisionRows = await sql<ProjectMetaRow[]>`
          insert into public.projects
            (user_id, id, meta, updated_at, last_opened_at, server_updated_at, revision)
          values
            (
              ${userId},
              ${snapshot.id},
              ${sql.json(toPostgresJson(stripProjectRevision(meta)))},
              ${meta.updatedAt},
              ${meta.lastOpenedAt},
              now(),
              1
            )
          returning meta, revision
        `;
        }
        const sourceObjectPaths = sourceWrite
          ? await this.writePreparedProjectSource(sql, userId, snapshot.id, sourceWrite.prepared)
          : [];
        await sql`
        insert into public.project_snapshots
          (user_id, id, snapshot, document_index, updated_at, server_updated_at)
        values
          (
            ${userId},
            ${snapshot.id},
            ${sql.json(toPostgresJson(snapshotWithoutDocumentIndex))},
            ${documentIndex === null ? null : sql.json(toPostgresJson(documentIndex))},
            ${snapshot.updatedAt},
            now()
          )
        on conflict (user_id, id) do update set
          snapshot = excluded.snapshot,
          document_index = excluded.document_index,
          updated_at = excluded.updated_at,
          server_updated_at = excluded.server_updated_at
      `;
        return {
          meta: mergeProjectMetaRow(revisionRows[0]),
          replacedObjectPaths: sourceObjectPaths,
          snapshot: snapshotToPersist,
        };
      };
      const transactionResult = sourceUploadSql
        ? await this.runReservedTransaction(sourceUploadSql, persistProject)
        : await this.sql.begin(persistProject);
      replacedObjectPaths = transactionResult.replacedObjectPaths;
      savedMeta = transactionResult.meta;
      snapshot = transactionResult.snapshot;
    } catch (error) {
      saveError = error;
    } finally {
      if (sourceUploadSql) {
        try {
          await this.unlockProjectSourceObjectPathsSession(sourceUploadSql, lockedObjectPaths);
        } catch (error) {
          saveError ??= error;
        } finally {
          sourceUploadSql.release();
        }
      }
    }
    if (saveError) {
      if (uploadedObjectPaths.length > 0) {
        await this.deleteUploadedSourcesAfterFailure(this.getSourceStorage(), uploadedObjectPaths);
      }
      throw saveError;
    }
    if (!savedMeta) {
      throw new Error('Saved project metadata is missing.');
    }

    for (const replacedObjectPath of replacedObjectPaths) {
      await this.deleteQueuedSourceObject(replacedObjectPath);
    }

    await this.ensurePlacement(userId, snapshot.id);
    return {
      meta: savedMeta,
      snapshot,
    };
  }

  async patchProject(
    userId: string,
    id: ProjectId,
    patch: ProjectPatch,
    options: ProjectWriteOptions = {}
  ): Promise<SavedProjectMeta> {
    const existing = await this.loadProject(userId, id);
    if (!existing) {
      throw new Error(`Progetto ${id} non trovato per patch.`);
    }

    const snapshot = applyProjectPatch(existing, patch, patch.updatedAt || timestampIso());
    return (await this.saveProject(userId, snapshot, options)).meta;
  }

  async setProjectFavorite(
    userId: string,
    id: ProjectId,
    isFavorite: boolean
  ): Promise<SavedProjectMeta> {
    const rows = await this.sql<ProjectMetaRow[]>`
      update public.projects
      set meta = jsonb_set(meta, '{isFavorite}', ${this.sql.json(isFavorite)}, true),
          server_updated_at = now(),
          revision = revision + 1
      where user_id = ${userId} and id = ${id}
      returning meta, revision
    `;
    if (!rows[0]) {
      throw new Error(`Progetto ${id} non trovato per aggiornamento preferito.`);
    }
    return mergeProjectMetaRow(rows[0]);
  }

  async deleteProject(userId: string, id: ProjectId): Promise<void> {
    let objectPaths: string[] = [];
    await this.sql.begin(async sql => {
      await sql`
        select id
        from public.projects
        where user_id = ${userId} and id = ${id}
        for update
      `;
      const sourceRows = await sql<ProjectSourceObjectPathRow[]>`
        select object_path
        from public.project_sources
        where user_id = ${userId} and project_id = ${id}
        for update
      `;
      const sourceFileRows = await sql<ProjectSourceObjectPathRow[]>`
        select object_path
        from public.project_source_files
        where user_id = ${userId} and project_id = ${id}
        for update
      `;
      const sourceEntryRows = await sql<ProjectSourceObjectPathRow[]>`
        select object_path
        from public.project_source_entries
        where user_id = ${userId} and project_id = ${id} and object_path is not null
        for update
      `;
      objectPaths = [
        ...new Set(
          [...sourceRows, ...sourceFileRows, ...sourceEntryRows].map(row => row.object_path)
        ),
      ];
      await sql`
        insert into public.project_source_deletions (object_path, created_at)
        select queued.object_path, now()
        from jsonb_to_recordset(
          ${sql.json(toPostgresJson(objectPaths.map(object_path => ({ object_path }))))}
        ) as queued(object_path text)
        on conflict (object_path) do nothing
      `;
      await sql`
        delete from public.project_covers
        where user_id = ${userId} and project_id = ${id}
      `;
      await sql`
        delete from public.project_sources
        where user_id = ${userId} and project_id = ${id}
      `;
      await sql`
        delete from public.projects
        where user_id = ${userId} and id = ${id}
      `;
    });

    for (const objectPath of objectPaths) {
      await this.deleteQueuedSourceObject(objectPath);
    }
  }

  async importProject(
    userId: string,
    data: unknown
  ): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
    const snapshot = normalizeProjectSnapshot(data, true);
    return this.saveProject(userId, snapshot);
  }

  async exportProject(userId: string, id: ProjectId): Promise<ProjectExportData | null> {
    const snapshot = await this.loadProject(userId, id);
    if (!snapshot) {
      return null;
    }

    const sourceRecord = isRecord(snapshot.source) ? snapshot.source : null;
    if (sourceRecord && Array.isArray(sourceRecord.sources) && sourceRecord.sources.length > 0) {
      return attachProjectSources(snapshot, await this.loadProjectSources(userId, id));
    }
    const source = await this.loadProjectSource(userId, id);
    return source ? attachProjectSource(snapshot, source) : snapshot;
  }

  async touchProject(userId: string, id: ProjectId): Promise<void> {
    const touchedAt = timestampIso();
    await this.sql`
      update public.projects
      set meta = jsonb_set(
            jsonb_set(meta, '{updatedAt}', to_jsonb(${touchedAt}::text), true),
            '{lastOpenedAt}',
            to_jsonb(${touchedAt}::text),
            true
          ),
          updated_at = ${touchedAt},
          last_opened_at = ${touchedAt},
          server_updated_at = now()
      where user_id = ${userId} and id = ${id}
    `;
  }

  async listFolders(userId: string): Promise<LibraryFolder[]> {
    const rows = await this.sql<FolderRow[]>`
      select folder
      from public.library_folders
      where user_id = ${userId}
      order by parent_folder_id asc nulls first, order_index asc, id asc
    `;

    return rows.map(row => row.folder).sort((left, right) => left.order - right.order);
  }

  async listPlacements(userId: string): Promise<LibraryPlacement[]> {
    await this.ensureAllProjectPlacements(userId);
    const rows = await this.sql<PlacementRow[]>`
      select placement
      from public.library_placements
      where user_id = ${userId}
      order by folder_id asc nulls first, order_index asc, project_id asc
    `;

    return rows.map(row => row.placement).sort((left, right) => left.order - right.order);
  }

  async createFolder(
    userId: string,
    { name, parentFolderId = null }: { name: string; parentFolderId?: string | null }
  ): Promise<LibraryFolder> {
    const resolvedParentFolderId = await this.resolveFolderId(userId, parentFolderId);
    const folders = await this.listFolders(userId);
    const now = timestampIso();
    const folder: LibraryFolder = {
      id: createFolderId(),
      name: resolveAvailableFolderName(name, folders, resolvedParentFolderId),
      parentFolderId: resolvedParentFolderId,
      createdAt: now,
      updatedAt: now,
      order: resolveNextFolderOrder(folders, resolvedParentFolderId),
    };

    await this.writeFolder(userId, folder);
    return folder;
  }

  async deleteFolder(userId: string, folderId: string): Promise<void> {
    const folder = await this.readFolder(userId, folderId);
    if (!folder) {
      return;
    }

    const reparentFolderId = folder.parentFolderId || null;
    const touchedAt = timestampIso();
    const folders = await this.listFolders(userId);
    const placements = await this.listPlacements(userId);

    await this.sql.begin(async sql => {
      for (const childFolder of folders) {
        if (childFolder.parentFolderId === folderId) {
          await this.writeFolderWithClient(sql, userId, {
            ...childFolder,
            parentFolderId: reparentFolderId,
            updatedAt: touchedAt,
          });
        }
      }

      for (const placement of placements) {
        if (placement.folderId === folderId) {
          await this.writePlacementWithClient(sql, userId, {
            ...placement,
            folderId: reparentFolderId,
            updatedAt: touchedAt,
          });
        }
      }

      await sql`
        delete from public.library_folders
        where user_id = ${userId} and id = ${folderId}
      `;
    });
  }

  async renameFolder(
    userId: string,
    folderId: string,
    name: string
  ): Promise<LibraryFolder | null> {
    const folder = await this.readFolder(userId, folderId);
    if (!folder) {
      return null;
    }

    const renamedFolder = {
      ...folder,
      name: resolveAvailableFolderName(
        name.trim() || folder.name,
        await this.listFolders(userId),
        folder.parentFolderId,
        folder.id
      ),
      updatedAt: timestampIso(),
    };
    await this.writeFolder(userId, renamedFolder);
    return renamedFolder;
  }

  async moveFolder(
    userId: string,
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ): Promise<LibraryFolder | null> {
    const folder = await this.readFolder(userId, folderId);
    if (!folder) {
      return null;
    }

    const resolvedParentFolderId = await this.resolveFolderId(userId, parentFolderId);
    if (resolvedParentFolderId === folderId) {
      return folder;
    }

    const descendantIds = collectFolderDescendantIds(await this.listFolders(userId), folderId);
    if (resolvedParentFolderId && descendantIds.has(resolvedParentFolderId)) {
      return folder;
    }

    const movedFolder = {
      ...folder,
      parentFolderId: resolvedParentFolderId,
      updatedAt: timestampIso(),
    };
    const folders = (await this.listFolders(userId)).map(currentFolder =>
      currentFolder.id === folderId ? movedFolder : currentFolder
    );
    const placements = await this.listPlacements(userId);
    const destinationItems = buildOrderedSiblingItems(folders, placements, resolvedParentFolderId);
    const reorderedDestinationItems = insertMovedSiblingItems(
      destinationItems,
      new Set([folderId]),
      targetIndex,
      [{ id: folderId, kind: 'folder', value: movedFolder }]
    );

    await this.persistSiblingOrders(
      userId,
      reorderedDestinationItems,
      resolvedParentFolderId,
      movedFolder.updatedAt
    );
    return movedFolder;
  }

  async moveProjects(
    userId: string,
    projectIds: ProjectId[],
    folderId: string | null,
    targetIndex?: number
  ): Promise<LibraryPlacement[]> {
    await this.ensureAllProjectPlacements(userId);
    const placements = await this.listPlacements(userId);
    const folders = await this.listFolders(userId);
    const updatedAt = timestampIso();
    const resolvedFolderId = await this.resolveFolderId(userId, folderId);
    const movingProjectIds = new Set(projectIds);
    const updatedPlacements = placements.map(placement =>
      movingProjectIds.has(placement.projectId)
        ? { ...placement, folderId: resolvedFolderId, updatedAt }
        : placement
    );
    const movedPlacementsById = new Map(
      updatedPlacements
        .filter(placement => movingProjectIds.has(placement.projectId))
        .map(placement => [placement.projectId, placement])
    );
    const movedItems = projectIds
      .map(projectId => movedPlacementsById.get(projectId))
      .filter((placement): placement is LibraryPlacement => Boolean(placement))
      .map(placement => ({ id: placement.projectId, kind: 'project' as const, value: placement }));
    const reorderedDestinationItems = insertMovedSiblingItems(
      buildOrderedSiblingItems(folders, updatedPlacements, resolvedFolderId),
      movingProjectIds,
      targetIndex,
      movedItems
    );

    await this.persistSiblingOrders(userId, reorderedDestinationItems, resolvedFolderId, updatedAt);
    return projectIds
      .map(projectId => movedPlacementsById.get(projectId))
      .filter((placement): placement is LibraryPlacement => Boolean(placement));
  }

  private async prepareProjectSourceWrite(
    userId: string,
    snapshot: ProjectSnapshot,
    sourceFile?: ProjectSaveOptions['sourceFile']
  ): Promise<{ prepared: PreparedProjectSource; snapshot: ProjectSnapshot } | null> {
    const embeddedSources = readEmbeddedProjectSources(snapshot);
    if (embeddedSources.length > 0) {
      const sourceIds = new Set<string>();
      const files = embeddedSources.map(source => {
        if (
          !/^source-[A-Za-z0-9._-]+$/u.test(source.id) ||
          sourceIds.has(source.id) ||
          !source.file.data
        ) {
          throw new Error('Project source set is invalid.');
        }
        sourceIds.add(source.id);
        const { bytes, ref: preparedRef } = prepareProjectSource(source.file, source.id);
        const ref: ProjectSourceRef = {
          ...preparedRef,
          objectPath: buildProjectSourceObjectPath(
            userId,
            snapshot.id,
            source.id,
            preparedRef.hash
          ),
        };
        return {
          bytes,
          position: source.position,
          ref,
        };
      });
      const primary = files[0];
      if (!primary) {
        throw new Error('Primary project source is missing.');
      }
      const prepared: PreparedProjectSource = {
        archiveEntries: [],
        files: files.map(source => ({ position: source.position, ref: source.ref })),
        objects: files.map(source => ({
          bytes: source.bytes,
          mimeType: source.ref.mimeType,
          path: source.ref.objectPath,
        })),
        primaryRef: primary.ref,
        sourceKind: 'file',
      };
      const refs = files.map(source => source.ref);
      return {
        prepared,
        snapshot: detachProjectSources(snapshot, refs),
      };
    }

    const embeddedSource = readEmbeddedProjectSource(snapshot);
    if (!sourceFile && !embeddedSource) {
      return null;
    }
    const snapshotSource = isRecord(snapshot.source) ? snapshot.source : null;
    const snapshotFile =
      snapshotSource && isRecord(snapshotSource.file) ? snapshotSource.file : null;
    if (
      sourceFile &&
      (snapshotSource?.kind !== 'archive' ||
        !snapshotFile ||
        snapshotFile.name !== sourceFile.name ||
        snapshotFile.mimeType !== sourceFile.mimeType ||
        snapshotFile.data !== '')
    ) {
      throw new Error('Binary archive metadata does not match the project source.');
    }
    const source = sourceFile
      ? { data: '', mimeType: sourceFile.mimeType, name: sourceFile.name }
      : embeddedSource;
    if (!source) {
      throw new Error('Project source is missing.');
    }
    const { bytes, ref: preparedRef } = sourceFile
      ? prepareProjectSourceBytes(
          source,
          sourceFile.bytes,
          typeof snapshotFile?.sourceId === 'string' ? snapshotFile.sourceId : undefined
        )
      : prepareProjectSource(source, source.sourceId);
    const ref: ProjectSourceRef = {
      ...preparedRef,
      objectPath: buildProjectSourceObjectPath(
        userId,
        snapshot.id,
        preparedRef.id,
        preparedRef.hash
      ),
    };
    const prepared = await this.prepareStoredProjectSource(userId, snapshot.id, source, bytes, ref);
    const detachedSnapshot = detachProjectSource(snapshot, ref);
    if (prepared.sourceKind === 'archive') {
      if (!isRecord(detachedSnapshot.source)) {
        throw new Error('Detached archive source is missing.');
      }
      detachedSnapshot.source = {
        ...detachedSnapshot.source,
        index: this.buildProjectSourceArchiveIndex(prepared.archiveEntries, ref),
      };
    }
    return {
      prepared,
      snapshot: detachedSnapshot,
    };
  }

  private buildProjectSourceArchiveIndex(
    entries: ReadonlyArray<
      Omit<
        Pick<
          ProjectSourceArchiveEntryMetadata,
          'byte_size' | 'content_kind' | 'kind' | 'path' | 'preview' | 'source_hash'
        >,
        'byte_size'
      > & { byte_size: number | string | null }
    >,
    version: Pick<ProjectSourceRef, 'hash' | 'id'>
  ): ProjectSourceArchiveIndex {
    return {
      entries: entries.map(entry =>
        entry.kind === 'directory'
          ? { kind: 'directory', path: entry.path }
          : {
              byteSize: Number(entry.byte_size),
              contentKind: entry.content_kind as 'binary' | 'text',
              hash: entry.source_hash as string,
              kind: 'file',
              path: entry.path,
              ...(entry.preview === null ? {} : { preview: entry.preview }),
            }
      ),
      version: {
        sourceHash: version.hash,
        sourceId: version.id,
      },
    };
  }

  private async canonicalizeDetachedProjectSource(
    sql: ProjectTransactionSql,
    userId: string,
    snapshot: ProjectSnapshot
  ): Promise<ProjectSnapshot> {
    const source = isRecord(snapshot.source) ? snapshot.source : null;
    if (!source || typeof source.kind !== 'string') {
      throw new Error('Detached project source is invalid.');
    }
    const primaryRows = await sql<ProjectSourceMetadataRow[]>`
      select
        source_id,
        source_kind,
        name,
        mime_type,
        source_hash,
        byte_size,
        object_path
      from public.project_sources
      where user_id = ${userId} and project_id = ${snapshot.id}
      for update
    `;
    const primaryRow = primaryRows[0];
    if (!primaryRow) {
      throw new Error('Detached project source has no stored metadata.');
    }

    if (Array.isArray(source.sources) && source.sources.length > 0) {
      if (primaryRow.source_kind !== 'file') {
        throw new Error('Detached project source kind does not match stored metadata.');
      }
      const fileRows = await sql<ProjectSourceFileRow[]>`
        select
          source_id,
          position,
          name,
          mime_type,
          source_hash,
          byte_size,
          object_path
        from public.project_source_files
        where user_id = ${userId} and project_id = ${snapshot.id}
        order by position
        for update
      `;
      const refs = fileRows.map(row => this.readProjectSourceRef(row));
      if (
        refs.length !== source.sources.length ||
        !this.sourceMetadataMatchesRef(primaryRow, refs[0])
      ) {
        throw new Error('Detached project source set does not match stored metadata.');
      }
      return detachProjectSources(snapshot, refs);
    }

    const expectedSourceKind = source.kind === 'archive' ? 'archive' : 'file';
    if (primaryRow.source_kind !== expectedSourceKind) {
      throw new Error('Detached project source kind does not match stored metadata.');
    }
    const ref = this.readProjectSourceRef(primaryRow);
    const submittedRef = isRecord(source.ref) ? source.ref : null;
    if (submittedRef?.id !== ref.id) {
      throw new Error('Detached project source identity does not match stored metadata.');
    }
    if (isRecord(source.file) && typeof source.file.sourceId === 'string') {
      if (source.file.sourceId !== ref.id) {
        throw new Error('Detached project source identity does not match stored metadata.');
      }
    }
    const detachedSnapshot = detachProjectSource(snapshot, ref);
    if (expectedSourceKind !== 'archive') {
      return detachedSnapshot;
    }
    const entryRows = await sql<ProjectSourceArchiveEntryRow[]>`
      select
        path,
        kind,
        content_kind,
        source_hash,
        byte_size,
        preview
      from public.project_source_entries
      where user_id = ${userId} and project_id = ${snapshot.id}
      order by path
      for update
    `;
    if (!isRecord(detachedSnapshot.source)) {
      throw new Error('Detached archive source is missing.');
    }
    detachedSnapshot.source = {
      ...detachedSnapshot.source,
      index: this.buildProjectSourceArchiveIndex(entryRows, ref),
    };
    return detachedSnapshot;
  }

  private readProjectSourceRef(
    row: ProjectSourceMetadataRow | ProjectSourceFileRow
  ): ProjectSourceRef {
    const byteSize = Number(row.byte_size);
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error('Stored project source size is invalid.');
    }
    return {
      byteSize,
      hash: row.source_hash,
      id: row.source_id,
      mimeType: row.mime_type,
      name: row.name,
      objectPath: row.object_path,
    };
  }

  private async detachUnchangedEmbeddedSource(
    userId: string,
    snapshot: ProjectSnapshot,
    authoritativeSnapshot: ProjectSnapshot
  ): Promise<ProjectSnapshot> {
    const embeddedSources = readEmbeddedProjectSources(snapshot);
    if (embeddedSources.length > 0) {
      const refs = embeddedSources.map(source => {
        const { ref } = prepareProjectSource(source.file, source.id);
        return {
          ...ref,
          objectPath: buildProjectSourceObjectPath(userId, snapshot.id, source.id, ref.hash),
        };
      });
      const [primaryRows, fileRows] = await Promise.all([
        this.sql<ProjectSourceMetadataRow[]>`
          select
            source_id,
            source_kind,
            name,
            mime_type,
            source_hash,
            byte_size,
            object_path
          from public.project_sources
          where user_id = ${userId} and project_id = ${snapshot.id}
          limit 1
        `,
        this.sql<ProjectSourceFileRow[]>`
          select
            source_id,
            position,
            name,
            mime_type,
            source_hash,
            byte_size,
            object_path
          from public.project_source_files
          where user_id = ${userId} and project_id = ${snapshot.id}
          order by position
        `,
      ]);
      const primary = primaryRows[0];
      if (
        primary?.source_kind !== 'file' ||
        refs.length !== fileRows.length ||
        !refs.every((ref, position) =>
          this.sourceMetadataMatchesRef(fileRows[position], ref, position)
        ) ||
        !this.sourceMetadataMatchesRef(primary, refs[0])
      ) {
        return snapshot;
      }
      return detachProjectSources(snapshot, refs);
    }

    const embeddedSource = readEmbeddedProjectSource(snapshot);
    if (!embeddedSource) {
      return snapshot;
    }
    const { ref: preparedRef } = prepareProjectSource(embeddedSource, embeddedSource.sourceId);
    const ref: ProjectSourceRef = {
      ...preparedRef,
      objectPath: buildProjectSourceObjectPath(
        userId,
        snapshot.id,
        preparedRef.id,
        preparedRef.hash
      ),
    };
    const rows = await this.sql<ProjectSourceMetadataRow[]>`
      select
        source_id,
        source_kind,
        name,
        mime_type,
        source_hash,
        byte_size,
        object_path
      from public.project_sources
      where user_id = ${userId} and project_id = ${snapshot.id}
      limit 1
    `;
    const expectedSourceKind =
      isRecord(snapshot.source) && snapshot.source.kind === 'archive' ? 'archive' : 'file';
    if (
      rows[0]?.source_kind !== expectedSourceKind ||
      !this.sourceMetadataMatchesRef(rows[0], ref)
    ) {
      return snapshot;
    }
    const detachedSnapshot = detachProjectSource(snapshot, ref);
    if (
      expectedSourceKind === 'archive' &&
      isRecord(detachedSnapshot.source) &&
      isRecord(authoritativeSnapshot.source) &&
      isRecord(authoritativeSnapshot.source.index)
    ) {
      detachedSnapshot.source = {
        ...detachedSnapshot.source,
        index: authoritativeSnapshot.source.index,
      };
    }
    return detachedSnapshot;
  }

  private sourceMetadataMatchesRef(
    row: ProjectSourceMetadataRow | ProjectSourceFileRow | undefined,
    ref: ProjectSourceRef,
    position?: number
  ): boolean {
    const byteSize = row ? Number(row.byte_size) : Number.NaN;
    return Boolean(
      row &&
        Number.isSafeInteger(byteSize) &&
        byteSize >= 0 &&
        (!('position' in row) || position === undefined || row.position === position) &&
        row.source_id === ref.id &&
        row.source_hash === ref.hash &&
        byteSize === ref.byteSize &&
        row.name === ref.name &&
        row.mime_type === ref.mimeType &&
        row.object_path === ref.objectPath
    );
  }

  private async writePreparedProjectSource(
    sql: ProjectTransactionSql,
    userId: string,
    projectId: string,
    prepared: PreparedProjectSource
  ): Promise<string[]> {
    const existingPrimaryRows = await sql<ProjectSourceObjectPathRow[]>`
      select object_path
      from public.project_sources
      where user_id = ${userId} and project_id = ${projectId}
      for update
    `;
    const existingFileRows = await sql<ProjectSourceObjectPathRow[]>`
      select object_path
      from public.project_source_files
      where user_id = ${userId} and project_id = ${projectId}
      for update
    `;
    const existingEntryRows = await sql<ProjectSourceObjectPathRow[]>`
      select object_path
      from public.project_source_entries
      where user_id = ${userId}
        and project_id = ${projectId}
        and object_path is not null
      for update
    `;
    const primary = prepared.primaryRef;
    await sql`
      insert into public.project_sources
        (
          user_id,
          project_id,
          source_id,
          source_hash,
          name,
          mime_type,
          byte_size,
          object_path,
          source_kind,
          updated_at
        )
      values
        (
          ${userId},
          ${projectId},
          ${primary.id},
          ${primary.hash},
          ${primary.name},
          ${primary.mimeType},
          ${primary.byteSize},
          ${primary.objectPath},
          ${prepared.sourceKind},
          now()
        )
      on conflict (user_id, project_id) do update set
        source_id = excluded.source_id,
        source_hash = excluded.source_hash,
        name = excluded.name,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        object_path = excluded.object_path,
        source_kind = excluded.source_kind,
        updated_at = excluded.updated_at
    `;
    await sql`
      delete from public.project_source_entries
      where user_id = ${userId} and project_id = ${projectId}
    `;
    await sql`
      delete from public.project_source_files
      where user_id = ${userId} and project_id = ${projectId}
    `;
    const newObjectPaths = [...new Set(prepared.objects.map(object => object.path))];
    const newObjectPathSet = new Set(newObjectPaths);
    await sql`
      delete from public.project_source_deletions
      where object_path in (
        select source.object_path
        from jsonb_to_recordset(
          ${sql.json(toPostgresJson(newObjectPaths.map(object_path => ({ object_path }))))}
        ) as source(object_path text)
      )
    `;
    if (prepared.files.length > 0) {
      await sql`
        insert into public.project_source_files
          (
            user_id,
            project_id,
            source_id,
            source_hash,
            name,
            mime_type,
            byte_size,
            object_path,
            position
          )
        select
          ${userId},
          ${projectId},
          source.source_id,
          source.source_hash,
          source.name,
          source.mime_type,
          source.byte_size,
          source.object_path,
          source.position
        from jsonb_to_recordset(
          ${sql.json(
            toPostgresJson(
              prepared.files.map(source => ({
                byte_size: source.ref.byteSize,
                mime_type: source.ref.mimeType,
                name: source.ref.name,
                object_path: source.ref.objectPath,
                position: source.position,
                source_hash: source.ref.hash,
                source_id: source.ref.id,
              }))
            )
          )}
        ) as source(
          source_id text,
          source_hash text,
          name text,
          mime_type text,
          byte_size bigint,
          object_path text,
          position integer
        )
      `;
    }
    if (prepared.archiveEntries.length > 0) {
      await sql`
        insert into public.project_source_entries
          (
            user_id,
            project_id,
            path,
            kind,
            content_kind,
            source_hash,
            byte_size,
            preview,
            object_path
          )
        select
          ${userId},
          ${projectId},
          entry.path,
          entry.kind,
          entry.content_kind,
          entry.source_hash,
          entry.byte_size,
          entry.preview,
          entry.object_path
        from jsonb_to_recordset(
          ${sql.json(toPostgresJson(prepared.archiveEntries))}
        ) as entry(
          path text,
          kind text,
          content_kind text,
          source_hash text,
          byte_size bigint,
          preview text,
          object_path text
        )
      `;
    }

    const replacedObjectPaths = [
      ...new Set(
        [...existingPrimaryRows, ...existingFileRows, ...existingEntryRows].map(
          row => row.object_path
        )
      ),
    ].filter(path => !newObjectPathSet.has(path));
    if (replacedObjectPaths.length > 0) {
      await sql`
        insert into public.project_source_deletions (object_path, created_at)
        select queued.object_path, now()
        from jsonb_to_recordset(
          ${sql.json(toPostgresJson(replacedObjectPaths.map(object_path => ({ object_path }))))}
        ) as queued(object_path text)
        on conflict (object_path) do nothing
      `;
    }
    return replacedObjectPaths;
  }

  private async prepareStoredProjectSource(
    userId: string,
    projectId: string,
    source: ProjectSourceFile,
    sourceBytes: Uint8Array,
    ref: ProjectSourceRef
  ): Promise<PreparedProjectSource> {
    const originalPath = buildProjectSourceObjectPath(userId, projectId, ref.id, ref.hash);
    const objects: PreparedProjectSource['objects'] = [
      {
        bytes: sourceBytes,
        mimeType: source.mimeType,
        path: originalPath,
      },
    ];
    if (!this.isArchiveSource(source)) {
      return {
        archiveEntries: [],
        files: [{ position: 0, ref }],
        objects,
        primaryRef: ref,
        sourceKind: 'file',
      };
    }
    if (sourceBytes.byteLength > PROJECT_SOURCE_ARCHIVE_MAX_COMPRESSED_BYTES) {
      throw new Error('Project source archive exceeds the configured compressed-size limit.');
    }

    return {
      archiveBytes: sourceBytes,
      archiveEntries: [],
      files: [],
      objects,
      primaryRef: ref,
      sourceKind: 'archive',
    };
  }

  private async uploadPreparedProjectSource(
    sql: postgres.ReservedSql,
    storage: ProjectSourceObjectStorage,
    userId: string,
    projectId: string,
    prepared: PreparedProjectSource,
    uploadedObjectPaths: string[],
    lockedObjectPaths: string[]
  ): Promise<void> {
    const inFlight = new Set<Promise<void>>();
    let inFlightBytes = 0;
    let uploadFailure: unknown;
    const sourceLockKeys = [
      ...new Set(prepared.objects.map(object => this.getProjectSourceLockKey(object.path))),
    ].sort(compareLockKeysByCodeUnit);
    await this.lockProjectSourceObjectPathsSession(sql, sourceLockKeys);
    lockedObjectPaths.push(...sourceLockKeys);

    const waitForCapacity = async (byteSize: number) => {
      if (uploadFailure) {
        throw uploadFailure;
      }
      while (
        inFlight.size >= SOURCE_UPLOAD_MAX_CONCURRENCY ||
        (inFlightBytes > 0 && inFlightBytes + byteSize > SOURCE_UPLOAD_MAX_IN_FLIGHT_BYTES)
      ) {
        await Promise.race(inFlight);
        if (uploadFailure) {
          throw uploadFailure;
        }
      }
    };

    const scheduleUpload = async (object: PreparedProjectSource['objects'][number]) => {
      await waitForCapacity(object.bytes.byteLength);
      inFlightBytes += object.bytes.byteLength;
      const task = this.uploadSourceObject(storage, object.path, object.bytes, {
        byteSize: object.bytes.byteLength,
        hash: createHash('sha256').update(object.bytes).digest('hex'),
        mimeType: object.mimeType,
      })
        .then(uploaded => {
          if (uploaded) {
            uploadedObjectPaths.push(object.path);
          }
        })
        .catch(error => {
          uploadFailure ??= error;
        })
        .finally(() => {
          inFlight.delete(task);
          inFlightBytes -= object.bytes.byteLength;
        });
      inFlight.add(task);
    };

    try {
      for (const object of [...prepared.objects].sort((left, right) =>
        left.path.localeCompare(right.path)
      )) {
        await scheduleUpload(object);
      }
      if (prepared.archiveBytes) {
        for await (const entry of streamSourceArchive(
          prepared.archiveBytes,
          PROJECT_SOURCE_ARCHIVE_LIMITS
        )) {
          if (entry.kind === 'directory') {
            prepared.archiveEntries.push({
              byte_size: null,
              content_kind: null,
              kind: entry.kind,
              object_path: null,
              path: entry.path,
              preview: null,
              source_hash: null,
            });
            continue;
          }
          const objectPath = buildProjectSourceEntryObjectPath(
            userId,
            projectId,
            prepared.primaryRef.id,
            prepared.primaryRef.hash,
            entry.path
          );
          prepared.archiveEntries.push({
            byte_size: entry.byteSize,
            content_kind: entry.text === undefined ? 'binary' : 'text',
            kind: entry.kind,
            object_path: objectPath,
            path: entry.path,
            preview: entry.preview ?? null,
            source_hash: entry.hash,
          });
          await scheduleUpload({
            bytes: entry.content,
            mimeType: entry.text === undefined ? 'application/octet-stream' : 'text/plain',
            path: objectPath,
          });
        }
      }
    } finally {
      await Promise.all(inFlight);
    }
    if (uploadFailure) {
      throw uploadFailure;
    }
  }

  private applyPreparedArchiveIndex(
    snapshot: ProjectSnapshot,
    prepared: PreparedProjectSource
  ): ProjectSnapshot {
    if (prepared.sourceKind !== 'archive') {
      return snapshot;
    }
    if (!isRecord(snapshot.source)) {
      throw new Error('Detached archive source is missing.');
    }
    return {
      ...snapshot,
      source: {
        ...snapshot.source,
        index: this.buildProjectSourceArchiveIndex(prepared.archiveEntries, prepared.primaryRef),
      },
    };
  }

  private async lockProjectSourceObjectPathsSession(
    sql: postgres.ReservedSql,
    lockKeys: readonly string[]
  ): Promise<void> {
    if (lockKeys.length === 0) {
      return;
    }
    await sql`
      select pg_advisory_lock(hashtextextended(locked.lock_key, 0))
      from (
        select source.lock_key
        from jsonb_to_recordset(
          ${sql.json(toPostgresJson(lockKeys.map(lock_key => ({ lock_key }))))}
        ) as source(lock_key text)
        order by source.lock_key
      ) as locked
    `;
  }

  private async runReservedTransaction<T>(
    sql: postgres.ReservedSql,
    operation: (sql: ProjectTransactionSql) => Promise<T>
  ): Promise<T> {
    await sql.unsafe('begin');
    try {
      const result = await operation(sql);
      await sql.unsafe('commit');
      return result;
    } catch (error) {
      await sql.unsafe('rollback');
      throw error;
    }
  }

  private async unlockProjectSourceObjectPathsSession(
    sql: postgres.ReservedSql,
    objectPaths: readonly string[]
  ): Promise<void> {
    if (objectPaths.length === 0) {
      return;
    }
    await sql`
      select pg_advisory_unlock(hashtextextended(locked.lock_key, 0))
      from (
        select source.lock_key
        from jsonb_to_recordset(
          ${sql.json(toPostgresJson(objectPaths.map(lock_key => ({ lock_key }))))}
        ) as source(lock_key text)
        order by source.lock_key desc
      ) as locked
    `;
  }

  private isArchiveSource(source: ProjectSourceFile): boolean {
    return (
      ZIP_SOURCE_MIME_TYPES.has(source.mimeType.toLowerCase()) ||
      source.name.toLowerCase().endsWith('.zip')
    );
  }

  private getSourceStorage(): ProjectSourceObjectStorage {
    this.sourceStorage ??= new SupabaseProjectSourceStorage({
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      supabaseUrl: process.env.SUPABASE_URL || '',
    });
    return this.sourceStorage;
  }

  private async uploadSourceObject(
    storage: ProjectSourceObjectStorage,
    objectPath: string,
    bytes: Uint8Array,
    ref: Pick<ProjectSourceRef, 'byteSize' | 'hash' | 'mimeType'>
  ): Promise<boolean> {
    try {
      await storage.upload(objectPath, bytes, ref.mimeType);
      return true;
    } catch (error) {
      if (
        !(error instanceof ProjectSourceStorageError) ||
        (error.status !== 400 && error.status !== 409)
      ) {
        throw error;
      }

      await storage.download(objectPath, {
        byteSize: ref.byteSize,
        hash: ref.hash,
      });
      return false;
    }
  }

  private async deleteUploadedSourcesAfterFailure(
    storage: ProjectSourceObjectStorage,
    objectPaths: readonly string[]
  ): Promise<void> {
    try {
      await this.sql.begin(async sql => {
        await this.lockProjectSourceObjectPaths(sql, objectPaths);
        for (const objectPath of objectPaths) {
          try {
            if (await this.isProjectSourceObjectReferenced(sql, objectPath)) {
              continue;
            }
            await storage.delete(objectPath);
          } catch (error) {
            await sql`
              insert into public.project_source_deletions (object_path, created_at)
              values (${objectPath}, now())
              on conflict (object_path) do nothing
            `;
            console.warn('[Projects] Failed to clean up an uncommitted source object.', {
              code: error instanceof ProjectSourceStorageError ? error.code : 'unknown',
              objectPath,
            });
          }
        }
      });
    } catch (error) {
      console.warn('[Projects] Failed to lock uncommitted source objects for cleanup.', {
        code: error instanceof ProjectSourceStorageError ? error.code : 'unknown',
      });
    }
  }

  private async lockProjectSourceObjectPaths(
    sql: postgres.TransactionSql,
    objectPaths: readonly string[]
  ): Promise<void> {
    const orderedLockKeys = [
      ...new Set(objectPaths.map(objectPath => this.getProjectSourceLockKey(objectPath))),
    ].sort(compareLockKeysByCodeUnit);
    if (orderedLockKeys.length === 0) {
      return;
    }
    await sql`
      select pg_advisory_xact_lock(hashtextextended(locked.lock_key, 0))
      from (
        select source.lock_key
        from jsonb_to_recordset(
          ${sql.json(toPostgresJson(orderedLockKeys.map(lock_key => ({ lock_key }))))}
        ) as source(lock_key text)
        order by source.lock_key
      ) as locked
    `;
  }

  private getProjectSourceLockKey(objectPath: string): string {
    const entrySegmentIndex = objectPath.indexOf(SOURCE_ENTRY_PATH_SEGMENT);
    if (entrySegmentIndex >= 0) {
      return objectPath.slice(0, entrySegmentIndex);
    }
    return objectPath.endsWith(SOURCE_ORIGINAL_PATH_SUFFIX)
      ? objectPath.slice(0, -SOURCE_ORIGINAL_PATH_SUFFIX.length)
      : objectPath;
  }

  private async drainQueuedSourceDeletions(): Promise<void> {
    let rows: ProjectSourceObjectPathRow[];
    try {
      rows = await this.sql<ProjectSourceObjectPathRow[]>`
        select object_path
        from public.project_source_deletions
        order by created_at, object_path
        limit ${SOURCE_DELETION_DRAIN_LIMIT}
      `;
    } catch (error) {
      console.warn('[Projects] Failed to read queued source deletions.', {
        code: error instanceof ProjectSourceStorageError ? error.code : 'unknown',
      });
      return;
    }

    for (const row of rows) {
      await this.deleteQueuedSourceObject(row.object_path);
    }
  }

  private startQueuedSourceDeletionDrain(): void {
    if (this.sourceDeletionDrainPromise) {
      return;
    }
    this.sourceDeletionDrainPromise = this.drainQueuedSourceDeletions().finally(() => {
      this.sourceDeletionDrainPromise = undefined;
    });
  }

  private async isProjectSourceObjectReferenced(
    sql: PostgresMutationSql,
    objectPath: string
  ): Promise<boolean> {
    const rows = await sql<Array<{ found: number }>>`
      select 1 as found
      from (
        select object_path from public.project_sources
        union all
        select object_path from public.project_source_files
        union all
        select object_path
        from public.project_source_entries
        where object_path is not null
      ) as referenced_source
      where referenced_source.object_path = ${objectPath}
      limit 1
    `;
    return Boolean(rows[0]);
  }

  private async deleteQueuedSourceObject(objectPath: string): Promise<void> {
    try {
      await this.sql.begin(async sql => {
        await this.lockProjectSourceObjectPaths(sql, [objectPath]);
        if (await this.isProjectSourceObjectReferenced(sql, objectPath)) {
          await sql`
            delete from public.project_source_deletions
            where object_path = ${objectPath}
          `;
          return;
        }
        await this.getSourceStorage().delete(objectPath);
        await sql`
          delete from public.project_source_deletions
          where object_path = ${objectPath}
        `;
      });
    } catch (error) {
      console.warn('[Projects] Source object deletion remains queued.', {
        code: error instanceof ProjectSourceStorageError ? error.code : 'unknown',
        objectPath,
      });
    }
  }

  private async readProjectMeta(userId: string, id: ProjectId): Promise<SavedProjectMeta | null> {
    const rows = await this.sql<ProjectMetaRow[]>`
      select meta, revision
      from public.projects
      where user_id = ${userId} and id = ${id}
      limit 1
    `;

    return rows[0] ? mergeProjectMetaRow(rows[0]) : null;
  }

  private async deleteExpiredProjectImportDiagnostics(
    sql: PostgresMutationSql = this.sql
  ): Promise<void> {
    await sql`
      delete from public.project_import_diagnostics
      where created_at < now() - ${PROJECT_IMPORT_DIAGNOSTIC_RETENTION_DAYS} * interval '1 day'
    `;
  }

  private async writeProjectMeta(
    userId: string,
    meta: SavedProjectMeta
  ): Promise<SavedProjectMeta> {
    const rows = await this.sql<ProjectMetaRow[]>`
      update public.projects
      set meta = jsonb_set(
            ${this.sql.json(toPostgresJson(stripProjectRevision(meta)))},
            '{isFavorite}',
            coalesce(meta -> 'isFavorite', 'false'::jsonb),
            true
          ),
          updated_at = ${meta.updatedAt},
          last_opened_at = ${meta.lastOpenedAt},
          server_updated_at = now(),
          revision = revision + 1
      where user_id = ${userId} and id = ${meta.id}
      returning meta, revision
    `;
    if (!rows[0]) {
      throw new Error(`Progetto ${meta.id} non trovato per aggiornamento metadata.`);
    }
    return mergeProjectMetaRow(rows[0]);
  }

  private async readFolder(userId: string, folderId: string): Promise<LibraryFolder | null> {
    const rows = await this.sql<FolderRow[]>`
      select folder
      from public.library_folders
      where user_id = ${userId} and id = ${folderId}
      limit 1
    `;

    return rows[0]?.folder ?? null;
  }

  private async writeFolder(userId: string, folder: LibraryFolder): Promise<void> {
    await this.writeFolderWithClient(this.sql, userId, folder);
  }

  private async writeFolderWithClient(
    sql: PostgresMutationSql,
    userId: string,
    folder: LibraryFolder
  ): Promise<void> {
    await sql`
      insert into public.library_folders
        (user_id, id, folder, parent_folder_id, order_index, updated_at)
      values
        (${userId}, ${folder.id}, ${sql.json(toPostgresJson(folder))}, ${folder.parentFolderId}, ${folder.order}, ${folder.updatedAt})
      on conflict (user_id, id) do update set
        folder = excluded.folder,
        parent_folder_id = excluded.parent_folder_id,
        order_index = excluded.order_index,
        updated_at = excluded.updated_at
    `;
  }

  private async writePlacement(userId: string, placement: LibraryPlacement): Promise<void> {
    await this.writePlacementWithClient(this.sql, userId, placement);
  }

  private async writePlacementWithClient(
    sql: PostgresMutationSql,
    userId: string,
    placement: LibraryPlacement
  ): Promise<void> {
    await sql`
      insert into public.library_placements
        (user_id, project_id, placement, folder_id, order_index, updated_at)
      values
        (${userId}, ${placement.projectId}, ${sql.json(toPostgresJson(placement))}, ${placement.folderId}, ${placement.order}, ${placement.updatedAt})
      on conflict (user_id, project_id) do update set
        placement = excluded.placement,
        folder_id = excluded.folder_id,
        order_index = excluded.order_index,
        updated_at = excluded.updated_at
    `;
  }

  private async ensurePlacement(userId: string, projectId: ProjectId): Promise<void> {
    const placements = await this.listPlacementsWithoutRepair(userId);
    const existingPlacement = placements.find(placement => placement.projectId === projectId);
    if (existingPlacement) {
      return;
    }

    await this.writePlacement(userId, {
      projectId,
      folderId: null,
      order: resolveNextPlacementOrder(placements, null),
      updatedAt: timestampIso(),
    });
  }

  private async ensureAllProjectPlacements(userId: string): Promise<void> {
    for (const meta of await this.listProjects(userId)) {
      await this.ensurePlacement(userId, meta.id);
    }
  }

  private async listPlacementsWithoutRepair(userId: string): Promise<LibraryPlacement[]> {
    const rows = await this.sql<PlacementRow[]>`
      select placement
      from public.library_placements
      where user_id = ${userId}
      order by folder_id asc nulls first, order_index asc, project_id asc
    `;

    return rows.map(row => row.placement);
  }

  private async resolveFolderId(
    userId: string,
    folderId: string | null | undefined
  ): Promise<string | null> {
    return folderId && (await this.readFolder(userId, folderId)) ? folderId : null;
  }

  private async persistSiblingOrders(
    userId: string,
    items: LibraryItem[],
    parentFolderId: string | null,
    updatedAt: string
  ): Promise<void> {
    for (const [index, item] of items.entries()) {
      const nextOrder = (index + 1) * SIBLING_ORDER_STEP;

      if (item.kind === 'folder') {
        await this.writeFolder(userId, {
          ...item.value,
          order: nextOrder,
          parentFolderId,
          updatedAt,
        });
        continue;
      }

      await this.writePlacement(userId, {
        ...item.value,
        folderId: parentFolderId,
        order: nextOrder,
        updatedAt,
      });
    }
  }
}
