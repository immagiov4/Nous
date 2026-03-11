import type { ProjectExportData, ProjectId, ProjectSnapshot, SavedProjectMeta } from '../types';

export class ProjectStorageError extends Error {
  code: 'quota-exceeded' | 'persistence-failed' | 'unknown';

  constructor(message: string, code: ProjectStorageError['code'] = 'unknown') {
    super(message);
    this.name = 'ProjectStorageError';
    this.code = code;
  }
}

export interface ProjectRepository {
  listProjects: () => Promise<SavedProjectMeta[]>;
  loadProject: (id: ProjectId) => Promise<ProjectSnapshot | null>;
  saveProject: (snapshot: ProjectSnapshot) => Promise<SavedProjectMeta>;
  deleteProject: (id: ProjectId) => Promise<void>;
  importProject: (data: unknown) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  exportProject: (id: ProjectId) => Promise<ProjectExportData | null>;
  touchProject: (id: ProjectId) => Promise<void>;
}

export interface DriveSyncAdapter {
  isConfigured: () => boolean;
  syncProject: (snapshot: ProjectSnapshot) => Promise<void>;
  pullProjects: () => Promise<ProjectSnapshot[]>;
}

export class NoopDriveSyncAdapter implements DriveSyncAdapter {
  isConfigured(): boolean {
    return false;
  }

  async syncProject(_snapshot: ProjectSnapshot): Promise<void> {}

  async pullProjects(): Promise<ProjectSnapshot[]> {
    return [];
  }
}
