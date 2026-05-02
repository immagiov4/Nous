import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { createEntityId } from '../utils/ids.js';
import { timestampIso } from '../utils/time.js';
import { buildProjectMeta, normalizeProjectSnapshot, PROJECT_SYNC_READY } from './projectMeta.js';
import {
  SIBLING_ORDER_STEP,
  type SiblingItem,
  buildOrderedSiblingItems,
  insertMovedSiblingItems,
  resolveNextFolderOrder,
  resolveNextPlacementOrder,
  collectFolderDescendantIds,
} from './siblingOrdering.js';
import type {
  LibraryFolder,
  LibraryPlacement,
  ProjectExportData,
  ProjectId,
  ProjectSnapshot,
  ProjectStore,
  SavedProjectMeta,
} from './types.js';

const DEFAULT_SQLITE_PATH = './apps/backend/data/lumina-projects.sqlite';

type LibraryItem = SiblingItem;

interface ProjectRow {
  meta_json: string;
}

interface SnapshotRow {
  snapshot_json: string;
  updated_at: string;
}

interface FolderRow {
  folder_json: string;
}

interface PlacementRow {
  placement_json: string;
}

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

const toEpochMillis = (value: string | undefined): number => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const createFolderId = (): string => createEntityId('folder');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..', '..');

const resolveDatabasePath = (): string => {
  if (process.env.PROJECT_SQLITE_PATH) {
    return resolve(repoRoot, process.env.PROJECT_SQLITE_PATH);
  }

  return resolve(repoRoot, DEFAULT_SQLITE_PATH);
};

export class SqliteProjectStore implements ProjectStore {
  private database: Database.Database;

  constructor(databasePath = resolveDatabasePath()) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  getConfig() {
    return {
      driver: 'sqlite' as const,
      isLanSyncEnabled: true,
    };
  }

  async listProjects(userId: string): Promise<SavedProjectMeta[]> {
    return this.readProjectMetas(userId).sort(
      (left, right) => toEpochMillis(right.lastOpenedAt) - toEpochMillis(left.lastOpenedAt)
    );
  }

  async loadProject(userId: string, id: ProjectId): Promise<ProjectSnapshot | null> {
    const row = this.database
      .prepare('select snapshot_json from project_snapshots where user_id = ? and id = ?')
      .get(userId, id) as SnapshotRow | undefined;

    return row ? normalizeProjectSnapshot(parseJson<ProjectSnapshot>(row.snapshot_json)) : null;
  }

  async loadProjectsById(userId: string, ids: ProjectId[]): Promise<ProjectSnapshot[]> {
    const snapshots = await Promise.all(ids.map(id => this.loadProject(userId, id)));
    return snapshots.filter((snapshot): snapshot is ProjectSnapshot => Boolean(snapshot));
  }

  async saveProject(userId: string, data: ProjectSnapshot): Promise<SavedProjectMeta> {
    const snapshot = normalizeProjectSnapshot(data);
    const existingSnapshot = this.readSnapshot(userId, snapshot.id);
    const existingMeta = this.readProjectMeta(userId, snapshot.id);

    if (
      existingSnapshot &&
      toEpochMillis(existingSnapshot.updatedAt) > toEpochMillis(snapshot.updatedAt)
    ) {
      const meta = buildProjectMeta(existingSnapshot, existingMeta, {
        touchedAt: existingMeta?.updatedAt || existingSnapshot.updatedAt,
      });
      this.writeProjectMeta(userId, meta);
      return meta;
    }

    const meta = buildProjectMeta(snapshot, existingMeta);
    const now = timestampIso();

    this.database
      .prepare(
        `insert into projects (user_id, id, meta_json, updated_at, server_updated_at, revision)
         values (?, ?, ?, ?, ?, 1)
         on conflict(user_id, id) do update set
           meta_json = excluded.meta_json,
           updated_at = excluded.updated_at,
           server_updated_at = excluded.server_updated_at,
           revision = projects.revision + 1`
      )
      .run(userId, snapshot.id, JSON.stringify(meta), meta.updatedAt, now);
    this.database
      .prepare(
        `insert into project_snapshots (user_id, id, snapshot_json, updated_at, server_updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(user_id, id) do update set
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at,
           server_updated_at = excluded.server_updated_at`
      )
      .run(userId, snapshot.id, JSON.stringify(snapshot), snapshot.updatedAt, now);

    this.ensurePlacement(userId, snapshot.id);
    return meta;
  }

  async deleteProject(userId: string, id: ProjectId): Promise<void> {
    this.database
      .prepare('delete from project_snapshots where user_id = ? and id = ?')
      .run(userId, id);
    this.database.prepare('delete from projects where user_id = ? and id = ?').run(userId, id);
    this.database
      .prepare('delete from library_placements where user_id = ? and project_id = ?')
      .run(userId, id);
  }

  async importProject(
    userId: string,
    data: unknown
  ): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
    const snapshot = normalizeProjectSnapshot(data, true);
    const meta = await this.saveProject(userId, snapshot);
    return { meta, snapshot };
  }

  async exportProject(userId: string, id: ProjectId): Promise<ProjectExportData | null> {
    const snapshot = await this.loadProject(userId, id);
    return snapshot;
  }

  async touchProject(userId: string, id: ProjectId): Promise<void> {
    const meta = this.readProjectMeta(userId, id);
    if (!meta) {
      return;
    }

    const touchedAt = timestampIso();
    const snapshot = this.readSnapshot(userId, id);
    const refreshedMeta = snapshot ? buildProjectMeta(snapshot, meta, { touchedAt }) : meta;

    this.writeProjectMeta(userId, {
      ...refreshedMeta,
      lastOpenedAt: touchedAt,
      updatedAt: touchedAt,
      syncState: PROJECT_SYNC_READY,
    });
  }

  async listFolders(userId: string): Promise<LibraryFolder[]> {
    return this.readFolders(userId).sort((left, right) => left.order - right.order);
  }

  async listPlacements(userId: string): Promise<LibraryPlacement[]> {
    this.ensureAllProjectPlacements(userId);
    return this.readPlacements(userId).sort((left, right) => left.order - right.order);
  }

  async createFolder(
    userId: string,
    { name, parentFolderId = null }: { name: string; parentFolderId?: string | null }
  ): Promise<LibraryFolder> {
    const resolvedParentFolderId = this.resolveFolderId(userId, parentFolderId);
    const now = timestampIso();
    const folder: LibraryFolder = {
      id: createFolderId(),
      name: name.trim() || 'Nuova cartella',
      parentFolderId: resolvedParentFolderId,
      createdAt: now,
      updatedAt: now,
      order: this.getNextFolderOrder(userId, resolvedParentFolderId),
    };

    this.writeFolder(userId, folder);
    return folder;
  }

  async deleteFolder(userId: string, folderId: string): Promise<void> {
    const folder = this.readFolder(userId, folderId);
    if (!folder) {
      return;
    }

    const reparentFolderId = folder.parentFolderId || null;
    const touchedAt = timestampIso();
    const transaction = this.database.transaction(() => {
      for (const childFolder of this.readFolders(userId)) {
        if (childFolder.parentFolderId === folderId) {
          this.writeFolder(userId, {
            ...childFolder,
            parentFolderId: reparentFolderId,
            updatedAt: touchedAt,
          });
        }
      }

      for (const placement of this.readPlacements(userId)) {
        if (placement.folderId === folderId) {
          this.writePlacement(userId, {
            ...placement,
            folderId: reparentFolderId,
            updatedAt: touchedAt,
          });
        }
      }

      this.database
        .prepare('delete from library_folders where user_id = ? and id = ?')
        .run(userId, folderId);
    });
    transaction();
  }

  async renameFolder(
    userId: string,
    folderId: string,
    name: string
  ): Promise<LibraryFolder | null> {
    const folder = this.readFolder(userId, folderId);
    if (!folder) {
      return null;
    }

    const renamedFolder = {
      ...folder,
      name: name.trim() || folder.name,
      updatedAt: timestampIso(),
    };
    this.writeFolder(userId, renamedFolder);
    return renamedFolder;
  }

  async moveFolder(
    userId: string,
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ): Promise<LibraryFolder | null> {
    const folder = this.readFolder(userId, folderId);
    if (!folder) {
      return null;
    }

    const resolvedParentFolderId = this.resolveFolderId(userId, parentFolderId);
    if (resolvedParentFolderId === folderId) {
      return folder;
    }

    if (
      resolvedParentFolderId &&
      this.getFolderDescendantIds(userId, folderId).has(resolvedParentFolderId)
    ) {
      return folder;
    }

    const movedFolder = {
      ...folder,
      parentFolderId: resolvedParentFolderId,
      updatedAt: timestampIso(),
    };
    const folders = this.readFolders(userId).map(currentFolder =>
      currentFolder.id === folderId ? movedFolder : currentFolder
    );
    const placements = this.readPlacements(userId);
    const destinationItems = this.buildOrderedSiblingItems(
      folders,
      placements,
      resolvedParentFolderId
    );
    const reorderedDestinationItems = this.insertMovedSiblingItems(
      destinationItems,
      new Set([folderId]),
      targetIndex,
      [{ id: folderId, kind: 'folder', value: movedFolder }]
    );

    const transaction = this.database.transaction(() => {
      const sourceParentFolderId = folder.parentFolderId || null;
      if (sourceParentFolderId !== resolvedParentFolderId) {
        this.persistSiblingOrders(
          userId,
          this.buildOrderedSiblingItems(folders, placements, sourceParentFolderId),
          sourceParentFolderId,
          movedFolder.updatedAt
        );
      }
      this.persistSiblingOrders(
        userId,
        reorderedDestinationItems,
        resolvedParentFolderId,
        movedFolder.updatedAt
      );
    });
    transaction();
    return movedFolder;
  }

  async moveProjects(
    userId: string,
    projectIds: ProjectId[],
    folderId: string | null,
    targetIndex?: number
  ): Promise<LibraryPlacement[]> {
    this.ensureAllProjectPlacements(userId);
    const placements = this.readPlacements(userId);
    const updatedAt = timestampIso();
    const resolvedFolderId = this.resolveFolderId(userId, folderId);
    const movingProjectIds = new Set(projectIds);
    const folders = this.readFolders(userId);
    const sourcePlacements = placements.filter(placement =>
      movingProjectIds.has(placement.projectId)
    );
    const updatedPlacements = placements.map(placement =>
      movingProjectIds.has(placement.projectId)
        ? {
            ...placement,
            folderId: resolvedFolderId,
            updatedAt,
          }
        : placement
    );
    const movedPlacementsById = new Map(
      updatedPlacements
        .filter(placement => movingProjectIds.has(placement.projectId))
        .map(placement => [placement.projectId, placement])
    );
    const destinationItems = this.buildOrderedSiblingItems(
      folders,
      updatedPlacements,
      resolvedFolderId
    );
    const movedItems = projectIds
      .map(projectId => movedPlacementsById.get(projectId))
      .filter((placement): placement is LibraryPlacement => Boolean(placement))
      .map(placement => ({ id: placement.projectId, kind: 'project' as const, value: placement }));
    const reorderedDestinationItems = this.insertMovedSiblingItems(
      destinationItems,
      movingProjectIds,
      targetIndex,
      movedItems
    );

    const transaction = this.database.transaction(() => {
      const touchedParentFolderIds = new Set<string | null>(
        sourcePlacements.map(placement => placement.folderId || null)
      );
      touchedParentFolderIds.add(resolvedFolderId);

      for (const parentFolderId of touchedParentFolderIds) {
        if (parentFolderId === resolvedFolderId) {
          this.persistSiblingOrders(userId, reorderedDestinationItems, parentFolderId, updatedAt);
          continue;
        }

        this.persistSiblingOrders(
          userId,
          this.buildOrderedSiblingItems(folders, updatedPlacements, parentFolderId).filter(
            item => !(item.kind === 'project' && movingProjectIds.has(item.id))
          ),
          parentFolderId,
          updatedAt
        );
      }
    });
    transaction();

    return projectIds
      .map(projectId => movedPlacementsById.get(projectId))
      .filter((placement): placement is LibraryPlacement => Boolean(placement));
  }

  private migrate(): void {
    this.database.exec(`
      create table if not exists projects (
        user_id text not null,
        id text not null,
        meta_json text not null,
        updated_at text not null,
        server_updated_at text not null,
        revision integer not null default 1,
        primary key (user_id, id)
      );

      create table if not exists project_snapshots (
        user_id text not null,
        id text not null,
        snapshot_json text not null,
        updated_at text not null,
        server_updated_at text not null,
        primary key (user_id, id)
      );

      create table if not exists library_folders (
        user_id text not null,
        id text not null,
        folder_json text not null,
        parent_folder_id text,
        order_index integer not null,
        updated_at text not null,
        primary key (user_id, id)
      );

      create table if not exists library_placements (
        user_id text not null,
        project_id text not null,
        placement_json text not null,
        folder_id text,
        order_index integer not null,
        updated_at text not null,
        primary key (user_id, project_id)
      );
    `);
  }

  private readProjectMetas(userId: string): SavedProjectMeta[] {
    const rows = this.database
      .prepare('select meta_json from projects where user_id = ? order by updated_at desc, id asc')
      .all(userId) as ProjectRow[];

    return rows.map(row => parseJson<SavedProjectMeta>(row.meta_json));
  }

  private readProjectMeta(userId: string, id: ProjectId): SavedProjectMeta | null {
    const row = this.database
      .prepare('select meta_json from projects where user_id = ? and id = ?')
      .get(userId, id) as ProjectRow | undefined;

    return row ? parseJson<SavedProjectMeta>(row.meta_json) : null;
  }

  private writeProjectMeta(userId: string, meta: SavedProjectMeta): void {
    this.database
      .prepare(
        `update projects
         set meta_json = ?, updated_at = ?, server_updated_at = ?, revision = revision + 1
         where user_id = ? and id = ?`
      )
      .run(JSON.stringify(meta), meta.updatedAt, timestampIso(), userId, meta.id);
  }

  private readSnapshot(userId: string, id: ProjectId): ProjectSnapshot | null {
    const row = this.database
      .prepare('select snapshot_json from project_snapshots where user_id = ? and id = ?')
      .get(userId, id) as SnapshotRow | undefined;

    return row ? normalizeProjectSnapshot(parseJson<ProjectSnapshot>(row.snapshot_json)) : null;
  }

  private readFolders(userId: string): LibraryFolder[] {
    const rows = this.database
      .prepare(
        'select folder_json from library_folders where user_id = ? order by parent_folder_id asc, order_index asc, id asc'
      )
      .all(userId) as FolderRow[];

    return rows.map(row => parseJson<LibraryFolder>(row.folder_json));
  }

  private readFolder(userId: string, folderId: string): LibraryFolder | null {
    const row = this.database
      .prepare('select folder_json from library_folders where user_id = ? and id = ?')
      .get(userId, folderId) as FolderRow | undefined;

    return row ? parseJson<LibraryFolder>(row.folder_json) : null;
  }

  private writeFolder(userId: string, folder: LibraryFolder): void {
    this.database
      .prepare(
        `insert into library_folders
           (user_id, id, folder_json, parent_folder_id, order_index, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(user_id, id) do update set
           folder_json = excluded.folder_json,
           parent_folder_id = excluded.parent_folder_id,
           order_index = excluded.order_index,
           updated_at = excluded.updated_at`
      )
      .run(
        userId,
        folder.id,
        JSON.stringify(folder),
        folder.parentFolderId,
        folder.order,
        folder.updatedAt
      );
  }

  private readPlacements(userId: string): LibraryPlacement[] {
    const rows = this.database
      .prepare(
        'select placement_json from library_placements where user_id = ? order by folder_id asc, order_index asc, project_id asc'
      )
      .all(userId) as PlacementRow[];

    return rows.map(row => parseJson<LibraryPlacement>(row.placement_json));
  }

  private writePlacement(userId: string, placement: LibraryPlacement): void {
    this.database
      .prepare(
        `insert into library_placements
           (user_id, project_id, placement_json, folder_id, order_index, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(user_id, project_id) do update set
           placement_json = excluded.placement_json,
           folder_id = excluded.folder_id,
           order_index = excluded.order_index,
           updated_at = excluded.updated_at`
      )
      .run(
        userId,
        placement.projectId,
        JSON.stringify(placement),
        placement.folderId,
        placement.order,
        placement.updatedAt
      );
  }

  private ensurePlacement(userId: string, projectId: ProjectId): void {
    const existingPlacement = this.readPlacements(userId).find(
      placement => placement.projectId === projectId
    );
    if (existingPlacement) {
      return;
    }

    this.writePlacement(userId, {
      projectId,
      folderId: null,
      order: this.resolveNextPlacementOrder(userId, null),
      updatedAt: timestampIso(),
    });
  }

  private ensureAllProjectPlacements(userId: string): void {
    for (const meta of this.readProjectMetas(userId)) {
      this.ensurePlacement(userId, meta.id);
    }
  }

  private resolveFolderId(userId: string, folderId: string | null | undefined): string | null {
    return folderId && this.readFolder(userId, folderId) ? folderId : null;
  }

  private getNextFolderOrder(userId: string, parentFolderId: string | null): number {
    return resolveNextFolderOrder(this.readFolders(userId), parentFolderId);
  }

  private resolveNextPlacementOrder(userId: string, folderId: string | null): number {
    return resolveNextPlacementOrder(this.readPlacements(userId), folderId);
  }

  private buildOrderedSiblingItems(
    folders: LibraryFolder[],
    placements: LibraryPlacement[],
    parentFolderId: string | null
  ): LibraryItem[] {
    return buildOrderedSiblingItems(folders, placements, parentFolderId);
  }

  private insertMovedSiblingItems(
    destinationItems: LibraryItem[],
    movingIds: Set<string>,
    targetIndex: number | undefined,
    movedItems: LibraryItem[]
  ): LibraryItem[] {
    return insertMovedSiblingItems(destinationItems, movingIds, targetIndex, movedItems);
  }

  private persistSiblingOrders(
    userId: string,
    items: LibraryItem[],
    parentFolderId: string | null,
    updatedAt: string
  ): void {
    for (const [index, item] of items.entries()) {
      const nextOrder = (index + 1) * SIBLING_ORDER_STEP;

      if (item.kind === 'folder') {
        this.writeFolder(userId, {
          ...item.value,
          order: nextOrder,
          parentFolderId,
          updatedAt,
        });
        continue;
      }

      this.writePlacement(userId, {
        ...item.value,
        folderId: parentFolderId,
        order: nextOrder,
        updatedAt,
      });
    }
  }

  private getFolderDescendantIds(userId: string, folderId: string): Set<string> {
    return collectFolderDescendantIds(this.readFolders(userId), folderId);
  }
}
