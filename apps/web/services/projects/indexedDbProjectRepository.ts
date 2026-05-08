// fallow-ignore-file unused-class-members — interface implementation methods
import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type {
  AppState,
  LaboratoryState,
  LearningPlan,
  LearningSection,
  LibraryFolder,
  LibraryPlacement,
  PdfDocumentAssets,
  PdfTextIndex,
  ProjectExportData,
  ProjectId,
  ProjectSnapshot,
  ProjectSource,
  QuizQuestion,
  SavedProjectMeta,
  SectionAnnotation,
  SyllabusItem,
  UserProfile,
} from '../../types';
import {
  buildOrderedSiblingItems,
  collectFolderDescendantIds,
  resolveInsertionIndex,
  resolveNextFolderOrder,
  resolveNextPlacementOrder,
  SIBLING_ORDER_STEP,
  type SiblingItem,
} from '../../utils/library/siblingOrdering.ts';
import { createLibraryFolderId } from '../../utils/library/tree.ts';
import { timestampIso } from '../../utils/time.ts';
import { type ProjectRepository, ProjectStorageError } from './projectRepository';
import {
  buildProjectMeta,
  exportProjectData,
  normalizeImportedProject,
  normalizeStoredProject,
} from './projectSnapshot';

const DB_NAME = 'lumina-reader-projects';
const DB_VERSION = 2;
const META_STORE = 'project-meta';
const SNAPSHOT_STORE = 'project-snapshots';
const FOLDER_STORE = 'library-folders';
const PLACEMENT_STORE = 'library-placements';

interface NousProjectDb extends DBSchema {
  [FOLDER_STORE]: {
    key: string;
    value: LibraryFolder;
  };
  [PLACEMENT_STORE]: {
    key: string;
    value: LibraryPlacement;
  };
  [META_STORE]: {
    key: string;
    value: SavedProjectMeta;
  };
  [SNAPSHOT_STORE]: {
    key: string;
    value: ProjectSnapshot;
  };
}

type NousProjectStoreName =
  | typeof META_STORE
  | typeof SNAPSHOT_STORE
  | typeof FOLDER_STORE
  | typeof PLACEMENT_STORE;

const canOpenExistingDatabase = (error: unknown) =>
  (error instanceof DOMException && error.name === 'VersionError') ||
  (error instanceof ProjectStorageError && error.code === 'persistence-failed');

const classifyStorageError = (error: unknown): ProjectStorageError => {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new ProjectStorageError(
      'Lo spazio locale del browser e finito. Elimina alcuni progetti o esportali.',
      'quota-exceeded'
    );
  }

  if (error instanceof ProjectStorageError) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : 'Errore sconosciuto durante il salvataggio locale.';
  return new ProjectStorageError(message, 'unknown');
};

export class IndexedDbProjectRepository implements ProjectRepository {
  private dbPromise: Promise<IDBPDatabase<NousProjectDb>>;
  private placementBackfillPromise: Promise<void> | null = null;

  /**
   * Per-project serialization queue.
   * Ensures that load→patch→save sequences for the same project ID
   * never interleave, preventing the second operation from loading a
   * stale snapshot and silently overwriting the first.
   */
  private pendingProjectOps = new Map<ProjectId, Promise<unknown>>();

  private async enqueueProjectOp<T>(projectId: ProjectId, fn: () => Promise<T>): Promise<T> {
    const previous = this.pendingProjectOps.get(projectId) ?? Promise.resolve();
    // Chain after previous operation — even if it failed, run this one.
    const next = previous.then(
      () => fn(),
      () => fn()
    );
    // Store a "tail" promise that always resolves so the chain never stalls.
    this.pendingProjectOps.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  constructor() {
    this.dbPromise = this.openDatabase();
  }

  private async openDatabase(): Promise<IDBPDatabase<NousProjectDb>> {
    let rejectBlockedOpen: ((reason?: unknown) => void) | null = null;

    try {
      return await Promise.race([
        openDB<NousProjectDb>(DB_NAME, DB_VERSION, {
          upgrade(database) {
            if (!database.objectStoreNames.contains(META_STORE)) {
              database.createObjectStore(META_STORE, { keyPath: 'id' });
            }

            if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
              database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
            }

            if (!database.objectStoreNames.contains(FOLDER_STORE)) {
              database.createObjectStore(FOLDER_STORE, { keyPath: 'id' });
            }

            if (!database.objectStoreNames.contains(PLACEMENT_STORE)) {
              database.createObjectStore(PLACEMENT_STORE, { keyPath: 'projectId' });
            }
          },
          blocked() {
            rejectBlockedOpen?.(
              new ProjectStorageError(
                'L aggiornamento della libreria locale e bloccato da un altra scheda di Nous ancora aperta. Chiudi le altre schede e ricarica.',
                'persistence-failed'
              )
            );
          },
        }),
        new Promise<IDBPDatabase<NousProjectDb>>((_, reject) => {
          rejectBlockedOpen = reject;
        }),
      ]);
    } catch (error) {
      if (canOpenExistingDatabase(error)) {
        return openDB<NousProjectDb>(DB_NAME);
      }

      throw classifyStorageError(error);
    }
  }

  private hasStore(db: IDBPDatabase<NousProjectDb>, storeName: NousProjectStoreName) {
    return db.objectStoreNames.contains(storeName);
  }

  private ensureStoreAvailable(
    db: IDBPDatabase<NousProjectDb>,
    storeName: typeof FOLDER_STORE | typeof PLACEMENT_STORE,
    featureLabel: string
  ) {
    if (this.hasStore(db, storeName)) {
      return;
    }

    throw new ProjectStorageError(
      `${featureLabel} non disponibile finche Firefox non completa l'aggiornamento della libreria locale. Chiudi eventuali altre schede di Nous e ricarica.`,
      'persistence-failed'
    );
  }

  private createPlacementRecord(
    projectId: ProjectId,
    folderId: string | null,
    order: number
  ): LibraryPlacement {
    return {
      projectId,
      folderId,
      order,
      updatedAt: timestampIso(),
    };
  }

  private resolveNextPlacementOrder(
    placements: LibraryPlacement[],
    folderId: string | null
  ): number {
    return resolveNextPlacementOrder(placements, folderId);
  }

  private async getNextFolderOrder(
    db: IDBPDatabase<NousProjectDb>,
    parentFolderId: string | null
  ): Promise<number> {
    const folders = await db.getAll(FOLDER_STORE);
    return resolveNextFolderOrder(folders, parentFolderId);
  }

  private async ensureAllProjectPlacements(
    db: IDBPDatabase<NousProjectDb>
  ): Promise<LibraryPlacement[]> {
    const metas = await db.getAll(META_STORE);
    if (!this.hasStore(db, PLACEMENT_STORE)) {
      return metas
        .slice()
        .sort(
          (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
        )
        .map((meta, index) =>
          this.createPlacementRecord(meta.id, null, (index + 1) * SIBLING_ORDER_STEP)
        );
    }

    const placements = await db.getAll(PLACEMENT_STORE);
    const placementByProjectId = new Map(
      placements.map(placement => [placement.projectId, placement])
    );
    const orderedMetas = metas
      .slice()
      .sort(
        (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
      );

    let nextOrder =
      (Math.max(0, ...placements.filter(item => item.folderId === null).map(item => item.order)) ||
        0) + SIBLING_ORDER_STEP;
    const createdPlacements: LibraryPlacement[] = [];

    for (const meta of orderedMetas) {
      if (placementByProjectId.has(meta.id)) {
        continue;
      }

      const nextPlacement = this.createPlacementRecord(meta.id, null, nextOrder);
      nextOrder += SIBLING_ORDER_STEP;
      createdPlacements.push(nextPlacement);
      placementByProjectId.set(nextPlacement.projectId, nextPlacement);
    }

    this.schedulePlacementBackfill(db, createdPlacements);

    return [...placements, ...createdPlacements].sort((left, right) => left.order - right.order);
  }

  private schedulePlacementBackfill(
    db: IDBPDatabase<NousProjectDb>,
    placements: LibraryPlacement[]
  ) {
    if (
      !this.hasStore(db, PLACEMENT_STORE) ||
      placements.length === 0 ||
      this.placementBackfillPromise
    ) {
      return;
    }

    this.placementBackfillPromise = (async () => {
      const tx = db.transaction(PLACEMENT_STORE, 'readwrite');
      const store = tx.objectStore(PLACEMENT_STORE);

      for (const placement of placements) {
        const existingPlacement = await store.get(placement.projectId);
        if (!existingPlacement) {
          await store.put(placement);
        }
      }

      await tx.done;
    })()
      .catch(() => {
        // Background backfill is best effort only.
      })
      .finally(() => {
        this.placementBackfillPromise = null;
      });
  }

  private buildOrderedSiblingItems(
    folders: LibraryFolder[],
    placements: LibraryPlacement[],
    parentFolderId: string | null
  ): SiblingItem[] {
    return buildOrderedSiblingItems(folders, placements, parentFolderId);
  }

  private resolveInsertionIndex(
    originalSiblingItems: Array<{ id: string }>,
    movingIds: Set<string>,
    targetIndex: number | undefined,
    filteredSiblingCount: number
  ) {
    return resolveInsertionIndex(
      originalSiblingItems,
      movingIds,
      targetIndex,
      filteredSiblingCount
    );
  }

  private async persistSiblingOrders(
    db: IDBPDatabase<NousProjectDb>,
    items: Array<
      | { id: string; kind: 'folder'; value: LibraryFolder }
      | { id: string; kind: 'project'; value: LibraryPlacement }
    >,
    parentFolderId: string | null,
    updatedAt: string
  ) {
    const tx = db.transaction([FOLDER_STORE, PLACEMENT_STORE], 'readwrite');
    const folderStore = tx.objectStore(FOLDER_STORE);
    const placementStore = tx.objectStore(PLACEMENT_STORE);

    for (const [index, item] of items.entries()) {
      const nextOrder = (index + 1) * SIBLING_ORDER_STEP;

      if (item.kind === 'folder') {
        await folderStore.put({
          ...item.value,
          order: nextOrder,
          parentFolderId,
          updatedAt,
        });
        continue;
      }

      await placementStore.put({
        ...item.value,
        folderId: parentFolderId,
        order: nextOrder,
        updatedAt,
      });
    }

    await tx.done;
  }

  private async getFolderDescendantIds(
    db: IDBPDatabase<NousProjectDb>,
    folderId: string
  ): Promise<Set<string>> {
    const folders = await db.getAll(FOLDER_STORE);
    return collectFolderDescendantIds(folders, folderId);
  }

  async createFolder({
    name,
    parentFolderId = null,
  }: {
    name: string;
    parentFolderId?: string | null;
  }): Promise<LibraryFolder> {
    const db = await this.dbPromise;
    this.ensureStoreAvailable(db, FOLDER_STORE, 'Creazione cartelle');
    const normalizedName = name.trim();
    const resolvedParentFolderId =
      parentFolderId && (await db.get(FOLDER_STORE, parentFolderId)) ? parentFolderId : null;
    const now = timestampIso();
    const nextFolder: LibraryFolder = {
      id: createLibraryFolderId(),
      name: normalizedName || 'Nuova cartella',
      parentFolderId: resolvedParentFolderId,
      createdAt: now,
      updatedAt: now,
      order: await this.getNextFolderOrder(db, resolvedParentFolderId),
    };

    await db.put(FOLDER_STORE, nextFolder);
    return nextFolder;
  }

  async deleteFolder(folderId: string): Promise<void> {
    const db = await this.dbPromise;
    this.ensureStoreAvailable(db, FOLDER_STORE, 'Gestione cartelle');
    this.ensureStoreAvailable(db, PLACEMENT_STORE, 'Gestione cartelle');
    const folder = await db.get(FOLDER_STORE, folderId);

    if (!folder) {
      return;
    }

    const tx = db.transaction([FOLDER_STORE, PLACEMENT_STORE], 'readwrite');
    const [folders, placements] = await Promise.all([
      tx.objectStore(FOLDER_STORE).getAll(),
      tx.objectStore(PLACEMENT_STORE).getAll(),
    ]);
    const reparentFolderId = folder.parentFolderId || null;
    const touchedAt = timestampIso();

    await Promise.all(
      folders
        .filter(currentFolder => currentFolder.parentFolderId === folderId)
        .map(currentFolder =>
          tx.objectStore(FOLDER_STORE).put({
            ...currentFolder,
            parentFolderId: reparentFolderId,
            updatedAt: touchedAt,
          })
        )
    );
    await Promise.all(
      placements
        .filter(placement => placement.folderId === folderId)
        .map(placement =>
          tx.objectStore(PLACEMENT_STORE).put({
            ...placement,
            folderId: reparentFolderId,
            updatedAt: touchedAt,
          })
        )
    );
    await tx.objectStore(FOLDER_STORE).delete(folderId);
    await tx.done;
  }

  async listFolders(): Promise<LibraryFolder[]> {
    const db = await this.dbPromise;
    if (!this.hasStore(db, FOLDER_STORE)) {
      return [];
    }
    const folders = await db.getAll(FOLDER_STORE);
    return folders.sort((left, right) => left.order - right.order);
  }

  async listPlacements(): Promise<LibraryPlacement[]> {
    const db = await this.dbPromise;
    const placements = await this.ensureAllProjectPlacements(db);
    return placements.sort((left, right) => left.order - right.order);
  }

  async listProjects(): Promise<SavedProjectMeta[]> {
    const db = await this.dbPromise;
    const items = await db.getAll(META_STORE);
    return items.sort(
      (a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime()
    );
  }

  async loadProject(id: ProjectId): Promise<ProjectSnapshot | null> {
    const db = await this.dbPromise;
    const snapshot = await db.get(SNAPSHOT_STORE, id);
    return snapshot ? normalizeStoredProject(snapshot) : null;
  }

  async loadProjectsById(ids: ProjectId[]): Promise<ProjectSnapshot[]> {
    const db = await this.dbPromise;
    const snapshots = await Promise.all(ids.map(id => db.get(SNAPSHOT_STORE, id)));
    return snapshots
      .filter((snapshot): snapshot is ProjectSnapshot => Boolean(snapshot))
      .map(normalizeStoredProject);
  }

  async moveFolder(
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ): Promise<LibraryFolder | null> {
    const db = await this.dbPromise;
    this.ensureStoreAvailable(db, FOLDER_STORE, 'Spostamento cartelle');
    this.ensureStoreAvailable(db, PLACEMENT_STORE, 'Spostamento cartelle');
    const folder = await db.get(FOLDER_STORE, folderId);
    if (!folder) {
      return null;
    }

    const resolvedParentFolderId =
      parentFolderId && (await db.get(FOLDER_STORE, parentFolderId)) ? parentFolderId : null;

    if (resolvedParentFolderId === folderId) {
      return folder;
    }

    if (resolvedParentFolderId) {
      const descendantIds = await this.getFolderDescendantIds(db, folderId);
      if (descendantIds.has(resolvedParentFolderId)) {
        return folder;
      }
    }

    const movedFolder = {
      ...folder,
      parentFolderId: resolvedParentFolderId,
      updatedAt: timestampIso(),
    };
    const folders = await db.getAll(FOLDER_STORE);
    const placements = await this.ensureAllProjectPlacements(db);
    const updatedFolders = folders.map(currentFolder =>
      currentFolder.id === folderId ? movedFolder : currentFolder
    );
    const originalDestinationItems = this.buildOrderedSiblingItems(
      updatedFolders,
      placements,
      resolvedParentFolderId
    );
    const filteredDestinationItems = originalDestinationItems.filter(
      item => !(item.kind === 'folder' && item.id === folderId)
    );
    const insertionIndex = this.resolveInsertionIndex(
      originalDestinationItems,
      new Set([folderId]),
      targetIndex,
      filteredDestinationItems.length
    );

    filteredDestinationItems.splice(insertionIndex, 0, {
      id: folderId,
      kind: 'folder',
      value: movedFolder,
    });

    const sourceParentFolderId = folder.parentFolderId || null;
    const touchedAt = movedFolder.updatedAt;
    if (sourceParentFolderId !== resolvedParentFolderId) {
      await this.persistSiblingOrders(
        db,
        this.buildOrderedSiblingItems(updatedFolders, placements, sourceParentFolderId),
        sourceParentFolderId,
        touchedAt
      );
    }
    await this.persistSiblingOrders(
      db,
      filteredDestinationItems,
      resolvedParentFolderId,
      touchedAt
    );
    return movedFolder;
  }

  async moveProjects(
    projectIds: ProjectId[],
    folderId: string | null,
    targetIndex?: number
  ): Promise<LibraryPlacement[]> {
    const db = await this.dbPromise;
    this.ensureStoreAvailable(db, FOLDER_STORE, 'Spostamento corsi');
    this.ensureStoreAvailable(db, PLACEMENT_STORE, 'Spostamento corsi');
    const placements = await this.ensureAllProjectPlacements(db);
    const updatedAt = timestampIso();
    const resolvedFolderId = folderId && (await db.get(FOLDER_STORE, folderId)) ? folderId : null;
    const movingProjectIds = new Set(projectIds);
    const folders = await db.getAll(FOLDER_STORE);
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
    const originalDestinationItems = this.buildOrderedSiblingItems(
      folders,
      updatedPlacements,
      resolvedFolderId
    );
    const filteredDestinationItems = originalDestinationItems.filter(
      item => !(item.kind === 'project' && movingProjectIds.has(item.id))
    );
    const insertionIndex = this.resolveInsertionIndex(
      originalDestinationItems,
      movingProjectIds,
      targetIndex,
      filteredDestinationItems.length
    );
    const movedItems = projectIds
      .map(projectId => movedPlacementsById.get(projectId))
      .filter((placement): placement is LibraryPlacement => Boolean(placement))
      .map(placement => ({
        id: placement.projectId,
        kind: 'project' as const,
        value: placement,
      }));

    filteredDestinationItems.splice(insertionIndex, 0, ...movedItems);

    const touchedParentFolderIds = new Set<string | null>(
      sourcePlacements.map(placement => placement.folderId || null)
    );
    touchedParentFolderIds.add(resolvedFolderId);

    for (const parentFolderId of touchedParentFolderIds) {
      if (parentFolderId === resolvedFolderId) {
        await this.persistSiblingOrders(db, filteredDestinationItems, parentFolderId, updatedAt);
        continue;
      }

      await this.persistSiblingOrders(
        db,
        this.buildOrderedSiblingItems(folders, updatedPlacements, parentFolderId).filter(
          item => !(item.kind === 'project' && movingProjectIds.has(item.id))
        ),
        parentFolderId,
        updatedAt
      );
    }

    return projectIds
      .map(projectId => movedPlacementsById.get(projectId))
      .filter((placement): placement is LibraryPlacement => Boolean(placement));
  }

  async renameFolder(folderId: string, name: string): Promise<LibraryFolder | null> {
    const db = await this.dbPromise;
    this.ensureStoreAvailable(db, FOLDER_STORE, 'Rinomina cartelle');
    const folder = await db.get(FOLDER_STORE, folderId);
    if (!folder) {
      return null;
    }

    const renamedFolder = {
      ...folder,
      name: name.trim() || folder.name,
      updatedAt: timestampIso(),
    };
    await db.put(FOLDER_STORE, renamedFolder);
    return renamedFolder;
  }

  async saveProject(snapshot: ProjectSnapshot): Promise<SavedProjectMeta> {
    return this.enqueueProjectOp(snapshot.id, async () => {
      try {
        const db = await this.dbPromise;
        const transactionStores: NousProjectStoreName[] = this.hasStore(db, PLACEMENT_STORE)
          ? [META_STORE, SNAPSHOT_STORE, PLACEMENT_STORE]
          : [META_STORE, SNAPSHOT_STORE];
        const tx = db.transaction(transactionStores, 'readwrite');
        const existingMeta = (await tx.objectStore(META_STORE).get(snapshot.id)) || null;
        const nextMeta = buildProjectMeta(snapshot, existingMeta);
        await tx.objectStore(SNAPSHOT_STORE).put(snapshot);
        await tx.objectStore(META_STORE).put(nextMeta);
        if (this.hasStore(db, PLACEMENT_STORE)) {
          const placementStore = tx.objectStore(PLACEMENT_STORE);
          const existingPlacement = await placementStore.get(snapshot.id);
          if (!existingPlacement) {
            const placements = await placementStore.getAll();
            await placementStore.put(
              this.createPlacementRecord(
                snapshot.id,
                null,
                this.resolveNextPlacementOrder(placements, null)
              )
            );
          }
        }
        await tx.done;
        return nextMeta;
      } catch (error) {
        throw classifyStorageError(error);
      }
    });
  }

  async patchProject(id: ProjectId, patch: Record<string, unknown>): Promise<SavedProjectMeta> {
    return this.enqueueProjectOp(id, async () => {
      const snapshot = await this.loadProject(id);
      if (!snapshot) {
        throw new ProjectStorageError(
          `Progetto ${id} non trovato per patch.`,
          'persistence-failed'
        );
      }

      // Apply patches
      if (patch.activeSectionId !== undefined)
        snapshot.activeSectionId = patch.activeSectionId as string | null;
      if (patch.activeLaboratoryExerciseId !== undefined)
        snapshot.activeLaboratoryExerciseId = patch.activeLaboratoryExerciseId as string | null;
      if (patch.state !== undefined) snapshot.state = patch.state as AppState;
      if (patch.isLearnMode !== undefined) snapshot.isLearnMode = patch.isLearnMode as boolean;
      if (patch.source !== undefined) snapshot.source = patch.source as ProjectSource | null;
      if (patch.learningPlan !== undefined)
        snapshot.learningPlan = patch.learningPlan as LearningPlan | null;
      if (patch.laboratory !== undefined)
        snapshot.laboratory = patch.laboratory as LaboratoryState | null;
      if (patch.userProfile !== undefined)
        snapshot.userProfile = patch.userProfile as UserProfile | null;
      if (patch.syllabus !== undefined) snapshot.syllabus = patch.syllabus as SyllabusItem[];
      if (patch.researchCoursePlan !== undefined)
        snapshot.researchCoursePlan =
          patch.researchCoursePlan as ProjectSnapshot['researchCoursePlan'];
      if (patch.researchDossiersBySectionId !== undefined)
        snapshot.researchDossiersBySectionId =
          patch.researchDossiersBySectionId as ProjectSnapshot['researchDossiersBySectionId'];
      if (patch.documentAssets !== undefined)
        snapshot.documentAssets = patch.documentAssets as PdfDocumentAssets | null;
      if (patch.documentIndex !== undefined)
        snapshot.documentIndex = patch.documentIndex as PdfTextIndex | null;
      if (patch.updatedAt !== undefined) snapshot.updatedAt = patch.updatedAt as string;

      // Apply section patch
      const sectionPatch = patch.section as Record<string, unknown> | undefined;
      if (sectionPatch?.sectionId && snapshot.learningPlan?.sections) {
        const sectionId = sectionPatch.sectionId as string;
        snapshot.learningPlan = {
          ...snapshot.learningPlan,
          sections: snapshot.learningPlan.sections.map(s =>
            s.id === sectionId
              ? {
                  ...s,
                  ...(sectionPatch.annotations !== undefined
                    ? { annotations: sectionPatch.annotations as SectionAnnotation[] }
                    : {}),
                  ...(sectionPatch.content !== undefined
                    ? { content: sectionPatch.content as string }
                    : {}),
                  ...(sectionPatch.generatedVisuals !== undefined
                    ? {
                        generatedVisuals:
                          sectionPatch.generatedVisuals as LearningSection['generatedVisuals'],
                      }
                    : {}),
                  ...(sectionPatch.imageRefs !== undefined
                    ? { imageRefs: sectionPatch.imageRefs as LearningSection['imageRefs'] }
                    : {}),
                  ...(sectionPatch.isCompleted !== undefined
                    ? { isCompleted: sectionPatch.isCompleted as boolean }
                    : {}),
                  ...(sectionPatch.quiz !== undefined
                    ? { quiz: sectionPatch.quiz as QuizQuestion[] }
                    : {}),
                }
              : s
          ),
        };
      }

      return this.saveProject(snapshot);
    });
  }

  async deleteProject(id: ProjectId): Promise<void> {
    const db = await this.dbPromise;
    const transactionStores: NousProjectStoreName[] = this.hasStore(db, PLACEMENT_STORE)
      ? [META_STORE, SNAPSHOT_STORE, PLACEMENT_STORE]
      : [META_STORE, SNAPSHOT_STORE];
    const tx = db.transaction(transactionStores, 'readwrite');
    await tx.objectStore(META_STORE).delete(id);
    await tx.objectStore(SNAPSHOT_STORE).delete(id);
    if (this.hasStore(db, PLACEMENT_STORE)) {
      await tx.objectStore(PLACEMENT_STORE).delete(id);
    }
    await tx.done;
  }

  async importProject(
    data: unknown
  ): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
    const snapshot = normalizeImportedProject(data);
    const meta = await this.saveProject(snapshot);
    return { meta, snapshot };
  }

  async exportProject(id: ProjectId): Promise<ProjectExportData | null> {
    const snapshot = await this.loadProject(id);
    return snapshot ? exportProjectData(snapshot) : null;
  }

  async touchProject(id: ProjectId): Promise<void> {
    const db = await this.dbPromise;
    const meta = await db.get(META_STORE, id);
    if (!meta) {
      return;
    }

    const touchedAt = timestampIso();
    const snapshot = await db.get(SNAPSHOT_STORE, id);
    const refreshedMeta = snapshot
      ? buildProjectMeta(normalizeStoredProject(snapshot), meta, { touchedAt })
      : meta;

    await db.put(META_STORE, {
      ...refreshedMeta,
      lastOpenedAt: touchedAt,
      updatedAt: touchedAt,
    });
  }
}
