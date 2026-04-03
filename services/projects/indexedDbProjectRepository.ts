import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ProjectExportData, ProjectId, ProjectSnapshot, SavedProjectMeta } from '../../types';
import { buildProjectMeta, exportProjectData, normalizeImportedProject, normalizeStoredProject } from './projectSnapshot';
import { ProjectStorageError, type ProjectRepository } from './projectRepository';

const DB_NAME = 'lumina-reader-projects';
const DB_VERSION = 1;
const META_STORE = 'project-meta';
const SNAPSHOT_STORE = 'project-snapshots';

interface LuminaProjectDb extends DBSchema {
  [META_STORE]: {
    key: string;
    value: SavedProjectMeta;
  };
  [SNAPSHOT_STORE]: {
    key: string;
    value: ProjectSnapshot;
  };
}

const classifyStorageError = (error: unknown): ProjectStorageError => {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new ProjectStorageError('Lo spazio locale del browser e finito. Elimina alcuni progetti o esportali.', 'quota-exceeded');
  }

  if (error instanceof ProjectStorageError) {
    return error;
  }

  const message = error instanceof Error ? error.message : 'Errore sconosciuto durante il salvataggio locale.';
  return new ProjectStorageError(message, 'unknown');
};

export class IndexedDbProjectRepository implements ProjectRepository {
  private dbPromise: Promise<IDBPDatabase<LuminaProjectDb>>;

  constructor() {
    this.dbPromise = openDB<LuminaProjectDb>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: 'id' });
        }

        if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
          database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
        }
      },
    });
  }

  async listProjects(): Promise<SavedProjectMeta[]> {
    const db = await this.dbPromise;
    const items = await db.getAll(META_STORE);
    return items.sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime());
  }

  async loadProject(id: ProjectId): Promise<ProjectSnapshot | null> {
    const db = await this.dbPromise;
    const snapshot = await db.get(SNAPSHOT_STORE, id);
    return snapshot ? normalizeStoredProject(snapshot) : null;
  }

  async saveProject(snapshot: ProjectSnapshot): Promise<SavedProjectMeta> {
    try {
      const db = await this.dbPromise;
      const tx = db.transaction([META_STORE, SNAPSHOT_STORE], 'readwrite');
      const existingMeta = (await tx.objectStore(META_STORE).get(snapshot.id)) || null;
      const nextMeta = buildProjectMeta(snapshot, existingMeta);
      await tx.objectStore(SNAPSHOT_STORE).put(snapshot);
      await tx.objectStore(META_STORE).put(nextMeta);
      await tx.done;
      return nextMeta;
    } catch (error) {
      throw classifyStorageError(error);
    }
  }

  async deleteProject(id: ProjectId): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction([META_STORE, SNAPSHOT_STORE], 'readwrite');
    await tx.objectStore(META_STORE).delete(id);
    await tx.objectStore(SNAPSHOT_STORE).delete(id);
    await tx.done;
  }

  async importProject(data: unknown): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
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

    const touchedAt = new Date().toISOString();

    await db.put(META_STORE, {
      ...meta,
      lastOpenedAt: touchedAt,
      updatedAt: touchedAt,
    });
  }
}
