// fallow-ignore-file unused-class-members — interface implementation methods
import type {
  FileData,
  LibraryFolder,
  LibraryPlacement,
  ProjectExportData,
  ProjectId,
  ProjectPatch,
  ProjectSnapshot,
  ProjectSourceRef,
  SavedProjectMeta,
} from '../../types';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';
import type { ProjectRepository } from './projectRepository';
import { ProjectStorageError } from './projectRepository';
import { PROJECT_SYNC_READY } from './projectSyncState.ts';

interface ApiResponse {
  success: boolean;
  error?: string;
  data?: ProjectExportData | null;
  folder?: LibraryFolder | null;
  folders?: LibraryFolder[];
  meta?: SavedProjectMeta;
  placements?: LibraryPlacement[];
  project?: ProjectSnapshot | null;
  projects?: ProjectSnapshot[] | SavedProjectMeta[];
  source?: FileData | null;
  sourceRef?: ProjectSourceRef;
  snapshot?: ProjectSnapshot;
}

const PROJECT_SYNC_ERROR_MESSAGE =
  'Sincronizzazione server non disponibile. Verifica che il backend sia acceso e raggiungibile.';
const PROJECT_SYNC_TIMEOUT_MESSAGE =
  'La sincronizzazione sta impiegando troppo tempo. Il backend e raggiungibile, ma non ha completato la richiesta.';
const PROJECT_REQUEST_TIMEOUT_MS = 15_000;

const createProjectSyncError = (error: unknown): ProjectStorageError => {
  console.warn('[Nous] Server project sync failed', error);
  if (error instanceof ProjectStorageError) {
    return error;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProjectStorageError(PROJECT_SYNC_TIMEOUT_MESSAGE, 'persistence-failed');
  }

  return new ProjectStorageError(PROJECT_SYNC_ERROR_MESSAGE, 'persistence-failed');
};

const readApiResponse = async <T>(response: Response): Promise<ApiResponse & T> => {
  try {
    return (await response.json()) as ApiResponse & T;
  } catch {
    return {
      success: false,
      error: response.statusText || 'Risposta backend non valida.',
    } as ApiResponse & T;
  }
};

const assertValue = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) {
    throw new ProjectStorageError(message, 'persistence-failed');
  }

  return value;
};

export class HttpProjectRepository implements ProjectRepository {
  private readonly baseUrl: string;

  constructor(baseUrl = getBackendUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async createFolder(args: {
    name: string;
    parentFolderId?: string | null;
  }): Promise<LibraryFolder> {
    const response = await this.request<{ folder?: LibraryFolder }>('/api/projects/folders', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return assertValue(response.folder, 'La cartella sincronizzata non e stata creata.');
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.request(`/api/projects/folders/${encodeURIComponent(folderId)}`, {
      method: 'DELETE',
    });
  }

  async listFolders(): Promise<LibraryFolder[]> {
    const response = await this.request<{ folders?: LibraryFolder[] }>('/api/projects/folders');
    return response.folders || [];
  }

  async listPlacements(): Promise<LibraryPlacement[]> {
    const response = await this.request<{ placements?: LibraryPlacement[] }>(
      '/api/projects/placements'
    );
    return response.placements || [];
  }

  async listProjects(): Promise<SavedProjectMeta[]> {
    const response = await this.request<{ projects?: SavedProjectMeta[] }>(
      '/api/projects/projects'
    );
    return (response.projects || []).map(project => ({
      ...project,
      syncState: PROJECT_SYNC_READY,
    }));
  }

  async loadProject(id: ProjectId): Promise<ProjectSnapshot | null> {
    const response = await this.request<{ project?: ProjectSnapshot | null }>(
      `/api/projects/projects/${encodeURIComponent(id)}`
    );
    return response.project || null;
  }

  async loadProjectSource(id: ProjectId): Promise<FileData | null> {
    const response = await this.request<{ source?: FileData | null }>(
      `/api/projects/projects/${encodeURIComponent(id)}/source`
    );
    return response.source || null;
  }

  async loadProjectsById(ids: ProjectId[]): Promise<ProjectSnapshot[]> {
    const response = await this.request<{ projects?: ProjectSnapshot[] }>(
      '/api/projects/projects/by-id',
      {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }
    );
    return response.projects || [];
  }

  async moveFolder(
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ): Promise<LibraryFolder | null> {
    const response = await this.request<{ folder?: LibraryFolder | null }>(
      `/api/projects/folders/${encodeURIComponent(folderId)}/move`,
      {
        method: 'POST',
        body: JSON.stringify({ parentFolderId, targetIndex }),
      }
    );
    return response.folder || null;
  }

  async moveProjects(
    projectIds: ProjectId[],
    folderId: string | null,
    targetIndex?: number
  ): Promise<LibraryPlacement[]> {
    const response = await this.request<{ placements?: LibraryPlacement[] }>(
      '/api/projects/placements/move',
      {
        method: 'POST',
        body: JSON.stringify({ projectIds, folderId, targetIndex }),
      }
    );
    return response.placements || [];
  }

  async renameFolder(folderId: string, name: string): Promise<LibraryFolder | null> {
    const response = await this.request<{ folder?: LibraryFolder | null }>(
      `/api/projects/folders/${encodeURIComponent(folderId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }
    );
    return response.folder || null;
  }

  async saveProject(snapshot: ProjectSnapshot): Promise<SavedProjectMeta> {
    const source = snapshot.source;
    let lightweightSnapshot = snapshot;
    if (source?.kind === 'pdf') {
      let sourceRef = source.ref;
      if (!sourceRef && source.file.data) {
        const sourceResponse = await this.request<{ sourceRef?: ProjectSourceRef }>(
          `/api/projects/projects/${encodeURIComponent(snapshot.id)}/source`,
          {
            method: 'POST',
            body: JSON.stringify({ source: source.file }),
          }
        );
        sourceRef = assertValue(
          sourceResponse.sourceRef,
          'La sorgente del progetto non e stata salvata.'
        );
      }
      if (!sourceRef) {
        throw new ProjectStorageError(
          'La sorgente del progetto non e disponibile.',
          'persistence-failed'
        );
      }
      lightweightSnapshot = {
        ...snapshot,
        source: {
          ...source,
          file: { ...source.file, data: '' },
          ref: sourceRef,
        },
      };
    }
    const response = await this.request<{ meta?: SavedProjectMeta }>(
      `/api/projects/projects/${encodeURIComponent(snapshot.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ snapshot: lightweightSnapshot }),
      }
    );
    return {
      ...assertValue(response.meta, 'Il progetto sincronizzato non e stato salvato.'),
      syncState: PROJECT_SYNC_READY,
    };
  }

  async patchProject(id: ProjectId, patch: ProjectPatch): Promise<SavedProjectMeta> {
    const response = await this.request<{ meta?: SavedProjectMeta }>(
      `/api/projects/projects/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ patch }),
      }
    );
    return {
      ...assertValue(response.meta, 'Il progetto sincronizzato non e stato aggiornato.'),
      syncState: PROJECT_SYNC_READY,
    };
  }

  async deleteProject(id: ProjectId): Promise<void> {
    await this.request(`/api/projects/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async importProject(
    data: unknown
  ): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
    const response = await this.request<{
      meta?: SavedProjectMeta;
      snapshot?: ProjectSnapshot;
    }>('/api/projects/import', {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
    return {
      meta: {
        ...assertValue(response.meta, 'Il progetto sincronizzato non e stato importato.'),
        syncState: PROJECT_SYNC_READY,
      },
      snapshot: assertValue(response.snapshot, 'Il progetto sincronizzato non e stato importato.'),
    };
  }

  async exportProject(id: ProjectId): Promise<ProjectExportData | null> {
    const response = await this.request<{ data?: ProjectExportData | null }>(
      `/api/projects/projects/${encodeURIComponent(id)}/export`,
      {
        method: 'POST',
      }
    );
    return response.data || null;
  }

  async touchProject(id: ProjectId): Promise<void> {
    await this.request(`/api/projects/projects/${encodeURIComponent(id)}/touch`, {
      method: 'POST',
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const requestUrl = `${this.baseUrl}${path}`;
    const timeoutController = new AbortController();
    const timeoutId = globalThis.setTimeout(() => {
      timeoutController.abort();
    }, PROJECT_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetchWithSupabaseAuth(requestUrl, {
        ...init,
        cache: init.cache || 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: init.signal || timeoutController.signal,
      });
      const data = await readApiResponse<T>(response);

      if (!response.ok || data.success === false) {
        throw new ProjectStorageError(
          data.error || response.statusText || 'Richiesta server non riuscita.',
          'persistence-failed'
        );
      }

      return data;
    } catch (error) {
      throw createProjectSyncError(error);
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }
}
