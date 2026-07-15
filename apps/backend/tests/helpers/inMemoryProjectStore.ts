import {
  buildOrderedSiblingItems,
  collectFolderDescendantIds,
  insertMovedSiblingItems,
  resolveNextFolderOrder,
  resolveNextPlacementOrder,
  SIBLING_ORDER_STEP,
  type SiblingItem,
} from '@shared/libraryOrdering';
import { resolveAvailableFolderName } from '../../src/projects/folderNames.js';
import { buildProjectMeta, normalizeProjectSnapshot } from '../../src/projects/projectMeta.js';
import { applyProjectPatch } from '../../src/projects/projectPatch.js';
import { ProjectRevisionConflictError } from '../../src/projects/projectRevision.js';
import {
  attachProjectSource,
  detachProjectSource,
  prepareProjectSource,
  readEmbeddedPdfSource,
} from '../../src/projects/projectSource.js';
import type {
  LibraryFolder,
  LibraryPlacement,
  ProjectCoverFile,
  ProjectExportData,
  ProjectId,
  ProjectPatch,
  ProjectSnapshot,
  ProjectSourceFile,
  ProjectSourceRef,
  ProjectStore,
  ProjectWriteOptions,
  SavedProjectMeta,
} from '../../src/projects/types.js';
import { createEntityId } from '../../src/utils/ids.js';
import { timestampIso } from '../../src/utils/time.js';

interface ProjectRecord {
  meta: SavedProjectMeta;
  snapshot: ProjectSnapshot;
}

const clone = <T>(value: T): T => structuredClone(value);

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
  private readonly coversByUser = new Map<string, Map<ProjectId, ProjectCoverFile>>();
  private readonly foldersByUser = new Map<string, Map<string, LibraryFolder>>();
  private readonly placementsByUser = new Map<string, Map<ProjectId, LibraryPlacement>>();

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

  async loadProject(userId: string, id: ProjectId): Promise<ProjectSnapshot | null> {
    const record = this.getProjects(userId).get(id);
    if (!record) {
      return null;
    }

    const embeddedSource = readEmbeddedPdfSource(record.snapshot);
    if (embeddedSource) {
      const ref = await this.saveProjectSource(userId, id, embeddedSource);
      record.snapshot = detachProjectSource(record.snapshot, ref);
    }

    return clone(record.snapshot);
  }

  async loadProjectSource(userId: string, id: ProjectId): Promise<ProjectSourceFile | null> {
    const source = this.getSources(userId).get(id);
    return source ? clone(source) : null;
  }

  async loadProjectCover(userId: string, id: ProjectId): Promise<ProjectCoverFile | null> {
    const cover = this.getCovers(userId).get(id);
    return cover ? clone(cover) : null;
  }

  async saveProjectCover(userId: string, id: ProjectId, cover: ProjectCoverFile): Promise<void> {
    this.getCovers(userId).set(id, clone(cover));
  }

  async saveProjectSource(
    userId: string,
    id: ProjectId,
    source: ProjectSourceFile
  ): Promise<ProjectSourceRef> {
    const { ref } = prepareProjectSource(source);
    this.getSources(userId).set(id, clone(source));
    return ref;
  }

  async loadProjectsById(userId: string, ids: ProjectId[]): Promise<ProjectSnapshot[]> {
    const snapshots = await Promise.all(ids.map(id => this.loadProject(userId, id)));
    return snapshots.filter((snapshot): snapshot is ProjectSnapshot => snapshot !== null);
  }

  async saveProject(
    userId: string,
    data: ProjectSnapshot,
    { expectedRevision }: ProjectWriteOptions = {}
  ): Promise<SavedProjectMeta> {
    this.fullSaveCount += 1;
    const projects = this.getProjects(userId);
    const existing = projects.get(data.id);
    if (expectedRevision !== undefined && existing?.meta.revision !== expectedRevision) {
      throw new ProjectRevisionConflictError();
    }

    let snapshot = normalizeProjectSnapshot(clone(data));
    const embeddedSource = readEmbeddedPdfSource(snapshot);
    if (embeddedSource) {
      const ref = await this.saveProjectSource(userId, snapshot.id, embeddedSource);
      snapshot = detachProjectSource(snapshot, ref);
    }

    if (
      expectedRevision === undefined &&
      existing &&
      toEpochMillis(existing.snapshot.updatedAt) > toEpochMillis(snapshot.updatedAt)
    ) {
      return clone(existing.meta);
    }

    const meta = {
      ...buildProjectMeta(snapshot, existing?.meta),
      revision: (existing?.meta.revision || 0) + 1,
    };
    projects.set(snapshot.id, { meta, snapshot });
    this.ensurePlacement(userId, snapshot.id);
    return clone(meta);
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
      throw new Error(`Progetto ${id} non trovato per patch.`);
    }
    if (
      options.expectedRevision !== undefined &&
      existing.meta.revision !== options.expectedRevision
    ) {
      throw new ProjectRevisionConflictError();
    }

    const snapshot = applyProjectPatch(existing.snapshot, patch, patch.updatedAt || timestampIso());
    const meta = {
      ...buildProjectMeta(snapshot, existing.meta),
      revision: (existing.meta.revision || 0) + 1,
    };
    projects.set(id, { meta, snapshot });
    return clone(meta);
  }

  async deleteProject(userId: string, id: ProjectId): Promise<void> {
    this.getProjects(userId).delete(id);
    this.getSources(userId).delete(id);
    this.getCovers(userId).delete(id);
    this.getPlacements(userId).delete(id);
  }

  async importProject(
    userId: string,
    data: unknown
  ): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
    const snapshot = normalizeProjectSnapshot(data, true);
    const meta = await this.saveProject(userId, snapshot);
    return { meta, snapshot: (await this.loadProject(userId, snapshot.id)) || snapshot };
  }

  async exportProject(userId: string, id: ProjectId): Promise<ProjectExportData | null> {
    const snapshot = await this.loadProject(userId, id);
    if (!snapshot) {
      return null;
    }

    const source = await this.loadProjectSource(userId, id);
    return source ? attachProjectSource(snapshot, source) : snapshot;
  }

  async touchProject(userId: string, id: ProjectId): Promise<void> {
    const record = this.getProjects(userId).get(id);
    if (!record) {
      return;
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

  seedStoredSnapshot(userId: string, snapshot: ProjectSnapshot): void {
    const normalized = normalizeProjectSnapshot(clone(snapshot));
    this.getProjects(userId).set(snapshot.id, {
      snapshot: normalized,
      meta: { ...buildProjectMeta(normalized), revision: 1 },
    });
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

  countStoredSources(userId: string): number {
    return this.getSources(userId).size;
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
