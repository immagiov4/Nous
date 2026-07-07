// fallow-ignore-file unused-class-members — interface implementation methods
import postgres from 'postgres';

import { createEntityId } from '../utils/ids.js';
import { timestampIso } from '../utils/time.js';
import { isRecord } from '../utils/validation.js';
import { resolveAvailableFolderName } from './folderNames.js';
import { buildProjectMeta, normalizeProjectSnapshot } from './projectMeta.js';
import {
  buildOrderedSiblingItems,
  collectFolderDescendantIds,
  insertMovedSiblingItems,
  resolveNextFolderOrder,
  resolveNextPlacementOrder,
  SIBLING_ORDER_STEP,
  type SiblingItem,
} from './siblingOrdering.js';
import type {
  LearningPlanNodeSnapshot,
  LearningPlanSnapshot,
  LibraryFolder,
  LibraryPlacement,
  ProjectExportData,
  ProjectId,
  ProjectPatch,
  ProjectSnapshot,
  ProjectStore,
  SavedProjectMeta,
  SectionPatch,
} from './types.js';

type PostgresSql = ReturnType<typeof postgres>;
type PostgresMutationSql = PostgresSql | postgres.TransactionSql;
type LibraryItem = SiblingItem;

interface ProjectMetaRow {
  meta: SavedProjectMeta;
}

interface ProjectSnapshotRow {
  document_index: unknown | null;
  snapshot: Omit<ProjectSnapshot, 'documentIndex'>;
}

interface FolderRow {
  folder: LibraryFolder;
}

interface PlacementRow {
  placement: LibraryPlacement;
}

const createFolderId = (): string => createEntityId('folder');
const LEARNING_PLAN_NOT_FOUND_ERROR = 'Learning plan non trovato';

const toPostgresJson = (value: unknown): postgres.JSONValue => value as postgres.JSONValue;

const toEpochMillis = (value: string | undefined): number => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const applySectionPatchToNode = (
  node: LearningPlanNodeSnapshot,
  sectionPatch: SectionPatch
): LearningPlanNodeSnapshot => ({
  ...node,
  ...(sectionPatch.annotations !== undefined ? { annotations: sectionPatch.annotations } : {}),
  ...(sectionPatch.content !== undefined ? { content: sectionPatch.content } : {}),
  ...(sectionPatch.generatedVisuals !== undefined
    ? { generatedVisuals: sectionPatch.generatedVisuals }
    : {}),
  ...(sectionPatch.imageRefs !== undefined ? { imageRefs: sectionPatch.imageRefs } : {}),
  ...(sectionPatch.isCompleted !== undefined ? { isCompleted: sectionPatch.isCompleted } : {}),
  ...(sectionPatch.quiz !== undefined ? { quiz: sectionPatch.quiz } : {}),
});

const patchLearningPlanSection = (
  learningPlan: LearningPlanSnapshot | null | undefined,
  sectionPatch: SectionPatch
): LearningPlanSnapshot => {
  if (!learningPlan) {
    throw new Error(LEARNING_PLAN_NOT_FOUND_ERROR);
  }

  if (Array.isArray(learningPlan.modules)) {
    return {
      ...learningPlan,
      modules: learningPlan.modules.map(module => ({
        ...module,
        children: Array.isArray(module.children)
          ? module.children.map(child =>
              isRecord(child) && child.id === sectionPatch.sectionId && child.kind !== 'exercise'
                ? applySectionPatchToNode(child, sectionPatch)
                : child
            )
          : module.children,
      })),
    };
  }

  if (Array.isArray(learningPlan.sections)) {
    return {
      ...learningPlan,
      sections: learningPlan.sections.map(section =>
        section.id === sectionPatch.sectionId
          ? applySectionPatchToNode(section, sectionPatch)
          : section
      ),
    };
  }

  throw new Error(LEARNING_PLAN_NOT_FOUND_ERROR);
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

  constructor(databaseUrl = process.env.DATABASE_URL?.trim(), sqlClient?: PostgresSql) {
    if (!databaseUrl && !sqlClient) {
      throw new Error('DATABASE_URL is required when PROJECT_STORAGE_DRIVER=postgres.');
    }

    this.sql = sqlClient ?? postgres(databaseUrl as string, { max: 10 });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  getConfig() {
    return {
      driver: 'postgres' as const,
      isServerStorageEnabled: true,
    };
  }

  async listProjects(userId: string): Promise<SavedProjectMeta[]> {
    const rows = await this.sql<ProjectMetaRow[]>`
      select meta
      from public.projects
      where user_id = ${userId}
      order by last_opened_at desc nulls last, updated_at desc, id asc
    `;

    return rows
      .map(row => row.meta)
      .sort((left, right) => toEpochMillis(right.lastOpenedAt) - toEpochMillis(left.lastOpenedAt));
  }

  async loadProject(userId: string, id: ProjectId): Promise<ProjectSnapshot | null> {
    const rows = await this.sql<ProjectSnapshotRow[]>`
      select snapshot, document_index
      from public.project_snapshots
      where user_id = ${userId} and id = ${id}
      limit 1
    `;

    return rows[0] ? mergeSnapshot(rows[0]) : null;
  }

  async loadProjectsById(userId: string, ids: ProjectId[]): Promise<ProjectSnapshot[]> {
    const snapshots = await Promise.all(ids.map(id => this.loadProject(userId, id)));
    return snapshots.filter((snapshot): snapshot is ProjectSnapshot => Boolean(snapshot));
  }

  async saveProject(userId: string, data: ProjectSnapshot): Promise<SavedProjectMeta> {
    const snapshot = normalizeProjectSnapshot(data);
    const existingSnapshot = await this.loadProject(userId, snapshot.id);
    const existingMeta = await this.readProjectMeta(userId, snapshot.id);

    if (
      existingSnapshot &&
      toEpochMillis(existingSnapshot.updatedAt) > toEpochMillis(snapshot.updatedAt)
    ) {
      const meta = buildProjectMeta(existingSnapshot, existingMeta, {
        touchedAt: existingMeta?.updatedAt || existingSnapshot.updatedAt,
      });
      await this.writeProjectMeta(userId, meta);
      return meta;
    }

    const meta = buildProjectMeta(snapshot, existingMeta);
    const { documentIndex, snapshotWithoutDocumentIndex } = splitSnapshot(snapshot);

    await this.sql.begin(async sql => {
      await sql`
        insert into public.projects
          (user_id, id, meta, updated_at, last_opened_at, server_updated_at, revision)
        values
          (
            ${userId},
            ${snapshot.id},
            ${sql.json(toPostgresJson(meta))},
            ${meta.updatedAt},
            ${meta.lastOpenedAt},
            now(),
            1
          )
        on conflict (user_id, id) do update set
          meta = excluded.meta,
          updated_at = excluded.updated_at,
          last_opened_at = excluded.last_opened_at,
          server_updated_at = excluded.server_updated_at,
          revision = public.projects.revision + 1
      `;
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
    });

    await this.ensurePlacement(userId, snapshot.id);
    return meta;
  }

  async patchProject(
    userId: string,
    id: ProjectId,
    patch: ProjectPatch
  ): Promise<SavedProjectMeta> {
    const existing = await this.loadProject(userId, id);
    if (!existing) {
      throw new Error(`Progetto ${id} non trovato per patch.`);
    }

    const snapshot = { ...existing };
    if (patch.activeSectionId !== undefined) snapshot.activeSectionId = patch.activeSectionId;
    if (patch.state !== undefined) snapshot.state = patch.state;
    if (patch.isLearnMode !== undefined) snapshot.isLearnMode = patch.isLearnMode;
    if (patch.source !== undefined) snapshot.source = patch.source as ProjectSnapshot['source'];
    if (patch.learningPlan !== undefined) {
      snapshot.learningPlan = patch.learningPlan as ProjectSnapshot['learningPlan'];
    }
    if (patch.userProfile !== undefined) {
      snapshot.userProfile = patch.userProfile as ProjectSnapshot['userProfile'];
    }
    if (patch.syllabus !== undefined) snapshot.syllabus = patch.syllabus;
    if (patch.researchCoursePlan !== undefined) {
      snapshot.researchCoursePlan = patch.researchCoursePlan;
    }
    if (patch.researchDossiersBySectionId !== undefined) {
      snapshot.researchDossiersBySectionId = patch.researchDossiersBySectionId;
    }
    if (patch.documentAssets !== undefined) snapshot.documentAssets = patch.documentAssets;
    if (patch.documentIndex !== undefined) snapshot.documentIndex = patch.documentIndex;
    if (patch.section) {
      snapshot.learningPlan = patchLearningPlanSection(snapshot.learningPlan, patch.section);
    }

    snapshot.updatedAt = patch.updatedAt || timestampIso();
    return this.saveProject(userId, snapshot);
  }

  async deleteProject(userId: string, id: ProjectId): Promise<void> {
    await this.sql`
      delete from public.projects
      where user_id = ${userId} and id = ${id}
    `;
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
    return this.loadProject(userId, id);
  }

  async touchProject(userId: string, id: ProjectId): Promise<void> {
    const existing = await this.loadProject(userId, id);
    const existingMeta = await this.readProjectMeta(userId, id);
    if (!existing || !existingMeta) {
      return;
    }

    const touchedAt = timestampIso();
    await this.writeProjectMeta(userId, buildProjectMeta(existing, existingMeta, { touchedAt }));
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

  private async readProjectMeta(userId: string, id: ProjectId): Promise<SavedProjectMeta | null> {
    const rows = await this.sql<ProjectMetaRow[]>`
      select meta
      from public.projects
      where user_id = ${userId} and id = ${id}
      limit 1
    `;

    return rows[0]?.meta ?? null;
  }

  private async writeProjectMeta(userId: string, meta: SavedProjectMeta): Promise<void> {
    await this.sql`
      update public.projects
      set meta = ${this.sql.json(toPostgresJson(meta))},
          updated_at = ${meta.updatedAt},
          last_opened_at = ${meta.lastOpenedAt},
          server_updated_at = now(),
          revision = revision + 1
      where user_id = ${userId} and id = ${meta.id}
    `;
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
