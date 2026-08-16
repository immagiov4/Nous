import {
  buildOrderedSiblingItems,
  collectFolderDescendantIds,
  insertMovedSiblingItems,
  resolveNextFolderOrder,
  resolveNextPlacementOrder,
  SIBLING_ORDER_STEP,
  type SiblingItem,
} from '@shared/libraryOrdering';
import {
  decodeProjectBackupArchive,
  PROJECT_BACKUP_MAX_ENTRIES,
  PROJECT_BACKUP_MAX_MANIFEST_BYTES,
  PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
} from '@shared/projectBackupArchive';
import {
  buildImportedProjectAssetIdentity,
  remapProjectAssetReferences,
} from '@shared/projectBackupAssets';
import { PROJECT_PATCH_REBASE_MODE } from '@shared/projectContract';
import { resolveAvailableFolderName } from '../../src/projects/folderNames.js';
import { buildProjectMeta, normalizeProjectSnapshot } from '../../src/projects/projectMeta.js';
import { applyProjectPatch, isNavigationProjectPatch } from '../../src/projects/projectPatch.js';
import {
  ProjectNotFoundError,
  ProjectRevisionConflictError,
} from '../../src/projects/projectRevision.js';
import {
  attachProjectSource,
  attachProjectSources,
  buildProjectSourceObjectPath,
  detachProjectSource,
  detachProjectSources,
  prepareProjectSource,
  prepareProjectSourceBytes,
  preserveStoredProjectSource,
  readEmbeddedProjectSource,
  readEmbeddedProjectSources,
} from '../../src/projects/projectSource.js';
import {
  indexSourceArchive,
  PROJECT_SOURCE_ARCHIVE_LIMITS,
} from '../../src/projects/sourceArchive.js';
import type {
  LibraryFolder,
  LibraryPlacement,
  ProjectCoverFile,
  ProjectCoverWriteOptions,
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
  ProjectSourceUpload,
  ProjectStore,
  SavedProjectMeta,
  StoredProjectSourceFile,
} from '../../src/projects/types.js';
import { createEntityId } from '../../src/utils/ids.js';
import { timestampIso } from '../../src/utils/time.js';

interface ProjectRecord {
  meta: SavedProjectMeta;
  snapshot: ProjectSnapshot;
}

const clone = <T>(value: T): T => structuredClone(value);
const PROJECT_IMPORT_DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PROJECT_IMPORT_DIAGNOSTIC_LIST_LIMIT = 200;
const INVALID_PROJECT_BACKUP_MESSAGE = 'Project backup archive is invalid.';

const toEpochMillis = (value: string | undefined): number => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
};

/**
 * Observable test double for project routes. It models the ProjectStore contract
 * without retaining a second production database engine.
 */
export class InMemoryProjectStore implements ProjectStore {
  private readonly projectsByUser = new Map<string, Map<ProjectId, ProjectRecord>>();
  private readonly sourcesByUser = new Map<string, Map<ProjectId, ProjectSourceFile>>();
  private readonly sourceSetsByUser = new Map<string, Map<ProjectId, StoredProjectSourceFile[]>>();
  private readonly sourceArchiveEntriesByUser = new Map<
    string,
    Map<ProjectId, Map<string, Uint8Array>>
  >();
  private readonly sourceArchiveIndexesByUser = new Map<
    string,
    Map<ProjectId, ProjectSourceArchiveIndex>
  >();
  private readonly coversByUser = new Map<string, Map<ProjectId, ProjectCoverFile>>();
  private readonly foldersByUser = new Map<string, Map<string, LibraryFolder>>();
  private readonly placementsByUser = new Map<string, Map<ProjectId, LibraryPlacement>>();
  private readonly projectImportDiagnostics: ProjectImportDiagnostic[] = [];

  fullSaveCount = 0;

  async listProjects(userId: string): Promise<SavedProjectMeta[]> {
    const records = [...this.getProjects(userId).values()];
    for (const record of records) {
      record.meta = {
        ...buildProjectMeta(record.snapshot, record.meta, { touchedAt: record.meta.updatedAt }),
        revision: record.meta.revision,
      };
    }

    return records
      .map(record => clone(record.meta))
      .sort((left, right) => toEpochMillis(right.lastOpenedAt) - toEpochMillis(left.lastOpenedAt));
  }

  async listProjectImportDiagnostics(correlationId?: string): Promise<ProjectImportDiagnostic[]> {
    const cutoff = Date.now() - PROJECT_IMPORT_DIAGNOSTIC_RETENTION_MS;
    return clone(this.projectImportDiagnostics)
      .filter(
        diagnostic =>
          Date.parse(diagnostic.createdAt) >= cutoff &&
          (!correlationId || diagnostic.correlationId === correlationId)
      )
      .sort((left, right) => right.id - left.id)
      .slice(0, PROJECT_IMPORT_DIAGNOSTIC_LIST_LIMIT);
  }

  async recordProjectImportDiagnostic(
    userId: string,
    diagnostic: ProjectImportDiagnosticInput
  ): Promise<void> {
    this.projectImportDiagnostics.push({
      ...clone(diagnostic),
      createdAt: timestampIso(),
      id: this.projectImportDiagnostics.length + 1,
      userId,
    });
  }

  async loadProject(userId: string, id: ProjectId): Promise<ProjectSnapshot | null> {
    const record = this.getProjects(userId).get(id);
    if (!record) {
      return null;
    }

    return clone(record.snapshot);
  }

  async loadProjectWithRevision(
    userId: string,
    id: ProjectId
  ): Promise<ProjectSnapshotWithRevision | null> {
    const record = this.getProjects(userId).get(id);
    if (!record) return null;
    return { revision: record.meta.revision, snapshot: clone(record.snapshot) };
  }

  async loadProjectSource(userId: string, id: ProjectId): Promise<ProjectSourceFile | null> {
    const source = this.getSources(userId).get(id);
    return source ? clone(source) : null;
  }

  async loadProjectSources(userId: string, id: ProjectId): Promise<StoredProjectSourceFile[]> {
    return clone(this.getSourceSets(userId).get(id) || []);
  }

  async loadProjectSourceArchiveIndex(
    userId: string,
    id: ProjectId
  ): Promise<ProjectSourceArchiveIndex | null> {
    const index = this.getSourceArchiveIndexes(userId).get(id);
    return index ? clone(index) : null;
  }

  async loadProjectSourceArchiveEntry(
    userId: string,
    id: ProjectId,
    path: string,
    version: ProjectSourceArchiveIndex['version']
  ): Promise<Uint8Array | null> {
    const index = this.getSourceArchiveIndexes(userId).get(id);
    if (
      index?.version.sourceId !== version.sourceId ||
      index?.version.sourceHash !== version.sourceHash
    ) {
      return null;
    }
    const entry = this.getSourceArchiveEntries(userId).get(id)?.get(path);
    return entry ? entry.slice() : null;
  }

  async loadProjectSourceArchiveEntryRange(
    userId: string,
    id: ProjectId,
    path: string,
    version: ProjectSourceArchiveIndex['version'],
    start: number,
    endExclusive: number
  ): Promise<Uint8Array | null> {
    const entry = await this.loadProjectSourceArchiveEntry(userId, id, path, version);
    return entry?.slice(start, endExclusive) ?? null;
  }

  async loadProjectCover(userId: string, id: ProjectId): Promise<ProjectCoverFile | null> {
    const cover = this.getCovers(userId).get(id);
    return cover ? clone(cover) : null;
  }

  async saveProjectCover(
    userId: string,
    id: ProjectId,
    cover: ProjectCoverFile,
    { expectedRevision }: ProjectCoverWriteOptions = {}
  ): Promise<boolean> {
    const record = this.getProjects(userId).get(id);
    if (!record) throw new ProjectNotFoundError();
    if (expectedRevision !== undefined && record.meta.revision !== expectedRevision) {
      return false;
    }
    this.getCovers(userId).set(id, clone(cover));
    return true;
  }

  private async storeProjectSource(
    userId: string,
    id: ProjectId,
    source: ProjectSourceFile,
    sourceBytes?: Uint8Array
  ): Promise<ProjectSourceRef> {
    const { bytes, ref: preparedRef } = sourceBytes
      ? prepareProjectSourceBytes(source, sourceBytes)
      : prepareProjectSource(source);
    const ref: ProjectSourceRef = {
      ...preparedRef,
      objectPath: buildProjectSourceObjectPath(userId, id, preparedRef.id, preparedRef.hash),
    };
    this.getSources(userId).set(
      id,
      clone(sourceBytes ? { ...source, data: Buffer.from(sourceBytes).toString('base64') } : source)
    );
    this.getSourceSets(userId).delete(id);
    if (
      source.mimeType.toLowerCase() === 'application/zip' ||
      source.mimeType.toLowerCase() === 'application/x-zip-compressed' ||
      source.name.toLowerCase().endsWith('.zip')
    ) {
      const archive = await indexSourceArchive(bytes, PROJECT_SOURCE_ARCHIVE_LIMITS);
      const entryBytes = new Map<string, Uint8Array>();
      this.getSourceArchiveIndexes(userId).set(id, {
        entries: archive.entries.map(entry => {
          if (entry.kind === 'directory') {
            return { kind: entry.kind, path: entry.path };
          }
          entryBytes.set(entry.path, entry.content.slice());
          return {
            byteSize: entry.byteSize,
            contentKind: entry.text === undefined ? 'binary' : 'text',
            hash: entry.hash,
            kind: entry.kind,
            path: entry.path,
            ...(entry.preview === undefined ? {} : { preview: entry.preview }),
          };
        }),
        version: {
          sourceHash: ref.hash,
          sourceId: ref.id,
        },
      });
      this.getSourceArchiveEntries(userId).set(id, entryBytes);
    } else {
      this.getSourceArchiveIndexes(userId).delete(id);
      this.getSourceArchiveEntries(userId).delete(id);
    }
    return ref;
  }

  private async storeProjectSources(
    userId: string,
    id: ProjectId,
    sources: ProjectSourceUpload[]
  ): Promise<ProjectSourceRef[]> {
    const storedSources = [...sources]
      .sort((left, right) => left.position - right.position)
      .map(source => {
        const { ref: preparedRef } = prepareProjectSource(source.file, source.id);
        return {
          file: { ...clone(source.file), sourceId: source.id },
          ref: {
            ...preparedRef,
            objectPath: buildProjectSourceObjectPath(userId, id, source.id, preparedRef.hash),
          },
        } satisfies StoredProjectSourceFile;
      });
    if (storedSources.length !== sources.length || storedSources.length === 0) {
      throw new Error('Project source set is invalid.');
    }
    this.getSourceSets(userId).set(id, storedSources);
    this.getSources(userId).set(id, clone(storedSources[0].file));
    this.getSourceArchiveIndexes(userId).delete(id);
    this.getSourceArchiveEntries(userId).delete(id);
    return storedSources.map(source => clone(source.ref));
  }

  async loadProjectsById(userId: string, ids: ProjectId[]): Promise<ProjectSnapshot[]> {
    const snapshots = await Promise.all(ids.map(id => this.loadProject(userId, id)));
    return snapshots.filter((snapshot): snapshot is ProjectSnapshot => snapshot !== null);
  }

  async saveProject(
    userId: string,
    data: ProjectSnapshot,
    { expectedRevision, importedCover, sourceFile }: ProjectSaveOptions = {}
  ): Promise<ProjectSaveResult> {
    this.fullSaveCount += 1;
    const projects = this.getProjects(userId);
    const existing = projects.get(data.id);
    if (expectedRevision !== undefined && !existing) {
      throw new ProjectNotFoundError();
    }
    if (expectedRevision !== undefined && existing?.meta.revision !== expectedRevision) {
      throw new ProjectRevisionConflictError();
    }

    let snapshot = normalizeProjectSnapshot(clone(data), false, {
      externalArchiveBytesAvailable: Boolean(sourceFile?.bytes.byteLength),
    });
    if (existing) {
      snapshot = preserveStoredProjectSource(snapshot, existing.snapshot);
    }
    const embeddedSources = readEmbeddedProjectSources(snapshot);
    if (embeddedSources.length > 0) {
      snapshot = detachProjectSources(
        snapshot,
        await this.storeProjectSources(userId, snapshot.id, embeddedSources)
      );
    } else {
      const embeddedSource = readEmbeddedProjectSource(snapshot);
      if (sourceFile || embeddedSource) {
        const source =
          embeddedSource ||
          ({
            data: '',
            mimeType: sourceFile?.mimeType || '',
            name: sourceFile?.name || '',
          } satisfies ProjectSourceFile);
        const ref = await this.storeProjectSource(userId, snapshot.id, source, sourceFile?.bytes);
        snapshot = detachProjectSource(snapshot, ref);
      } else if (snapshot.source != null && !this.getSources(userId).has(snapshot.id)) {
        throw new Error('Detached project source has no stored metadata.');
      }
    }

    if (
      expectedRevision === undefined &&
      existing &&
      toEpochMillis(existing.snapshot.updatedAt) > toEpochMillis(snapshot.updatedAt)
    ) {
      return clone({ meta: existing.meta, snapshot: existing.snapshot });
    }

    const meta = {
      ...buildProjectMeta(snapshot, existing?.meta),
      revision: (existing?.meta.revision || 0) + 1,
    };
    projects.set(snapshot.id, { meta, snapshot });
    if (importedCover) this.getCovers(userId).set(snapshot.id, clone(importedCover));
    this.ensurePlacement(userId, snapshot.id);
    return clone({ meta, snapshot });
  }

  async patchProject(
    userId: string,
    id: ProjectId,
    patch: ProjectPatch,
    options: ProjectWriteOptions = {}
  ): Promise<SavedProjectMeta> {
    const projects = this.getProjects(userId);
    const existing = projects.get(id);
    if (!existing) {
      throw new ProjectNotFoundError();
    }
    if (
      options.rebaseMode !== PROJECT_PATCH_REBASE_MODE.navigation &&
      options.expectedRevision !== undefined &&
      existing.meta.revision !== options.expectedRevision
    ) {
      throw new ProjectRevisionConflictError();
    }
    if (
      options.rebaseMode === PROJECT_PATCH_REBASE_MODE.navigation &&
      !isNavigationProjectPatch(patch)
    ) {
      throw new TypeError('Navigation rebase accepts only navigation fields.');
    }

    const snapshot = applyProjectPatch(existing.snapshot, patch, patch.updatedAt || timestampIso());
    const meta = {
      ...buildProjectMeta(snapshot, existing.meta),
      revision: (existing.meta.revision || 0) + 1,
    };
    projects.set(id, { meta, snapshot });
    return clone(meta);
  }

  async setProjectFavorite(
    userId: string,
    id: ProjectId,
    isFavorite: boolean
  ): Promise<SavedProjectMeta> {
    const record = this.getProjects(userId).get(id);
    if (!record) {
      throw new ProjectNotFoundError();
    }
    record.meta = {
      ...record.meta,
      isFavorite,
      revision: (record.meta.revision || 0) + 1,
    };
    return clone(record.meta);
  }

  async deleteProject(userId: string, id: ProjectId): Promise<void> {
    this.getProjects(userId).delete(id);
    this.getSources(userId).delete(id);
    this.getSourceSets(userId).delete(id);
    this.getSourceArchiveEntries(userId).delete(id);
    this.getSourceArchiveIndexes(userId).delete(id);
    this.getCovers(userId).delete(id);
    this.getPlacements(userId).delete(id);
  }

  async importProject(
    userId: string,
    data: unknown
  ): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
    const snapshot = normalizeProjectSnapshot(data, true);
    return this.saveProject(userId, snapshot);
  }

  async importProjectArchive(
    userId: string,
    bytes: Uint8Array,
    targetProjectId: ProjectId
  ): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
    const decoded = await decodeProjectBackupArchive(bytes, {
      invalidArchiveMessage: INVALID_PROJECT_BACKUP_MESSAGE,
      maxEntries: PROJECT_BACKUP_MAX_ENTRIES,
      maxManifestBytes: PROJECT_BACKUP_MAX_MANIFEST_BYTES,
      maxTotalAttachmentBytes: PROJECT_BACKUP_MAX_TOTAL_ATTACHMENT_BYTES,
    });
    const sourceSnapshot = normalizeProjectSnapshot(decoded.project, true);
    const idMap = new Map<string, string>();
    for (const { ref } of decoded.assets) {
      const identity = await buildImportedProjectAssetIdentity({
        contentHash: ref.hash,
        projectId: targetProjectId,
        sourceAssetId: ref.id,
        userId,
      });
      idMap.set(ref.id, identity.id);
    }
    const snapshot = remapProjectAssetReferences({ ...sourceSnapshot, id: targetProjectId }, idMap);
    return this.saveProject(userId, snapshot, { importedCover: decoded.cover });
  }

  async exportProject(userId: string, id: ProjectId): Promise<ProjectSnapshot | null> {
    const snapshot = await this.loadProject(userId, id);
    if (!snapshot) {
      return null;
    }

    const source = snapshot.source as { sources?: unknown[] } | null | undefined;
    if (source?.sources?.length) {
      return attachProjectSources(snapshot, await this.loadProjectSources(userId, id));
    }
    const primarySource = await this.loadProjectSource(userId, id);
    return primarySource ? attachProjectSource(snapshot, primarySource) : snapshot;
  }

  async touchProject(userId: string, id: ProjectId): Promise<void> {
    const record = this.getProjects(userId).get(id);
    if (!record) {
      throw new ProjectNotFoundError();
    }

    const touchedAt = timestampIso();
    record.meta = {
      ...buildProjectMeta(record.snapshot, record.meta, { touchedAt }),
      lastOpenedAt: touchedAt,
      updatedAt: touchedAt,
      revision: record.meta.revision,
    };
  }

  async listFolders(userId: string): Promise<LibraryFolder[]> {
    return [...this.getFolders(userId).values()]
      .map(clone)
      .sort((left, right) => left.order - right.order);
  }

  async listPlacements(userId: string): Promise<LibraryPlacement[]> {
    this.ensureAllProjectPlacements(userId);
    return [...this.getPlacements(userId).values()]
      .map(clone)
      .sort((left, right) => left.order - right.order);
  }

  async createFolder(
    userId: string,
    { name, parentFolderId = null }: { name: string; parentFolderId?: string | null }
  ): Promise<LibraryFolder> {
    const folders = this.getFolders(userId);
    const resolvedParentFolderId = this.resolveFolderId(userId, parentFolderId);
    const now = timestampIso();
    const folder: LibraryFolder = {
      id: createEntityId('folder'),
      name: resolveAvailableFolderName(name, [...folders.values()], resolvedParentFolderId),
      parentFolderId: resolvedParentFolderId,
      createdAt: now,
      updatedAt: now,
      order: resolveNextFolderOrder([...folders.values()], resolvedParentFolderId),
    };
    folders.set(folder.id, folder);
    return clone(folder);
  }

  async deleteFolder(userId: string, folderId: string): Promise<void> {
    const folders = this.getFolders(userId);
    const folder = folders.get(folderId);
    if (!folder) {
      return;
    }

    const updatedAt = timestampIso();
    for (const child of folders.values()) {
      if (child.parentFolderId === folderId) {
        child.parentFolderId = folder.parentFolderId;
        child.updatedAt = updatedAt;
      }
    }
    for (const placement of this.getPlacements(userId).values()) {
      if (placement.folderId === folderId) {
        placement.folderId = folder.parentFolderId;
        placement.updatedAt = updatedAt;
      }
    }
    folders.delete(folderId);
  }

  async renameFolder(
    userId: string,
    folderId: string,
    name: string
  ): Promise<LibraryFolder | null> {
    const folders = this.getFolders(userId);
    const folder = folders.get(folderId);
    if (!folder) {
      return null;
    }

    const renamed = {
      ...folder,
      name: resolveAvailableFolderName(
        name,
        [...folders.values()],
        folder.parentFolderId,
        folder.id
      ),
      updatedAt: timestampIso(),
    };
    folders.set(folderId, renamed);
    return clone(renamed);
  }

  async moveFolder(
    userId: string,
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ): Promise<LibraryFolder | null> {
    const folders = this.getFolders(userId);
    const folder = folders.get(folderId);
    if (!folder) {
      return null;
    }

    const resolvedParentFolderId = this.resolveFolderId(userId, parentFolderId);
    if (
      resolvedParentFolderId === folderId ||
      (resolvedParentFolderId &&
        collectFolderDescendantIds([...folders.values()], folderId).has(resolvedParentFolderId))
    ) {
      return clone(folder);
    }

    const updatedAt = timestampIso();
    const movedFolder = { ...folder, parentFolderId: resolvedParentFolderId, updatedAt };
    folders.set(folderId, movedFolder);
    const siblings = buildOrderedSiblingItems(
      [...folders.values()],
      [...this.getPlacements(userId).values()],
      resolvedParentFolderId
    );
    this.persistSiblingOrders(
      userId,
      insertMovedSiblingItems(siblings, new Set([folderId]), targetIndex, [
        { id: folderId, kind: 'folder', value: movedFolder },
      ]),
      resolvedParentFolderId,
      updatedAt
    );
    return clone(movedFolder);
  }

  async moveProjects(
    userId: string,
    projectIds: ProjectId[],
    folderId: string | null,
    targetIndex?: number
  ): Promise<LibraryPlacement[]> {
    this.ensureAllProjectPlacements(userId);
    const placements = this.getPlacements(userId);
    const resolvedFolderId = this.resolveFolderId(userId, folderId);
    const updatedAt = timestampIso();
    const movingIds = new Set(projectIds);
    const movedItems: SiblingItem[] = projectIds
      .map(projectId => placements.get(projectId))
      .filter((placement): placement is LibraryPlacement => placement !== undefined)
      .map(placement => ({
        id: placement.projectId,
        kind: 'project' as const,
        value: { ...placement, folderId: resolvedFolderId, updatedAt },
      }));
    const destinationItems = buildOrderedSiblingItems(
      [...this.getFolders(userId).values()],
      [...placements.values()],
      resolvedFolderId
    );
    this.persistSiblingOrders(
      userId,
      insertMovedSiblingItems(destinationItems, movingIds, targetIndex, movedItems),
      resolvedFolderId,
      updatedAt
    );
    return movedItems.map(item => clone(item.value as LibraryPlacement));
  }

  replaceProjectMeta(userId: string, id: ProjectId, meta: SavedProjectMeta): void {
    const record = this.getProjects(userId).get(id);
    if (!record) {
      throw new Error(`Progetto ${id} non trovato nel test store.`);
    }
    record.meta = clone(meta);
  }

  readStoredSnapshot(userId: string, id: ProjectId): ProjectSnapshot | null {
    const record = this.getProjects(userId).get(id);
    return record ? clone(record.snapshot) : null;
  }

  private ensurePlacement(userId: string, projectId: ProjectId): void {
    const placements = this.getPlacements(userId);
    if (placements.has(projectId)) {
      return;
    }
    placements.set(projectId, {
      projectId,
      folderId: null,
      order: resolveNextPlacementOrder([...placements.values()], null),
      updatedAt: timestampIso(),
    });
  }

  private ensureAllProjectPlacements(userId: string): void {
    for (const projectId of this.getProjects(userId).keys()) {
      this.ensurePlacement(userId, projectId);
    }
  }

  private resolveFolderId(userId: string, folderId: string | null | undefined): string | null {
    return folderId && this.getFolders(userId).has(folderId) ? folderId : null;
  }

  private persistSiblingOrders(
    userId: string,
    items: SiblingItem[],
    parentFolderId: string | null,
    updatedAt: string
  ): void {
    for (const [index, item] of items.entries()) {
      const order = (index + 1) * SIBLING_ORDER_STEP;
      if (item.kind === 'folder') {
        this.getFolders(userId).set(item.id, {
          ...item.value,
          order,
          parentFolderId,
          updatedAt,
        });
      } else {
        this.getPlacements(userId).set(item.id, {
          ...item.value,
          order,
          folderId: parentFolderId,
          updatedAt,
        });
      }
    }
  }

  private getProjects(userId: string): Map<ProjectId, ProjectRecord> {
    return this.getUserMap(this.projectsByUser, userId);
  }

  private getSources(userId: string): Map<ProjectId, ProjectSourceFile> {
    return this.getUserMap(this.sourcesByUser, userId);
  }

  private getSourceSets(userId: string): Map<ProjectId, StoredProjectSourceFile[]> {
    return this.getUserMap(this.sourceSetsByUser, userId);
  }

  private getSourceArchiveEntries(userId: string): Map<ProjectId, Map<string, Uint8Array>> {
    return this.getUserMap(this.sourceArchiveEntriesByUser, userId);
  }

  private getSourceArchiveIndexes(userId: string): Map<ProjectId, ProjectSourceArchiveIndex> {
    return this.getUserMap(this.sourceArchiveIndexesByUser, userId);
  }

  private getCovers(userId: string): Map<ProjectId, ProjectCoverFile> {
    return this.getUserMap(this.coversByUser, userId);
  }

  private getFolders(userId: string): Map<string, LibraryFolder> {
    return this.getUserMap(this.foldersByUser, userId);
  }

  private getPlacements(userId: string): Map<ProjectId, LibraryPlacement> {
    return this.getUserMap(this.placementsByUser, userId);
  }

  private getUserMap<Key, Value>(
    collection: Map<string, Map<Key, Value>>,
    userId: string
  ): Map<Key, Value> {
    const existing = collection.get(userId);
    if (existing) {
      return existing;
    }
    const created = new Map<Key, Value>();
    collection.set(userId, created);
    return created;
  }
}
