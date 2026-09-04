import type { LibraryFolder, LibraryPlacement } from './projectContract';

export const LIBRARY_ARCHIVE_FORMAT = 'nous-library-archive';
export const LIBRARY_ARCHIVE_VERSION = 2;
export const LIBRARY_ARCHIVE_EXTENSION = '.nous-library.zip';
export const LIBRARY_ARCHIVE_MANIFEST_PATH = 'library.json';
export const LIBRARY_ARCHIVE_PROJECTS_DIR = 'projects';
export const LIBRARY_ARCHIVE_MIME_TYPE = 'application/zip';

export interface LibraryArchiveProjectEntry {
  id: string;
  path: string;
  title: string;
}

export interface LibraryArchiveManifest {
  archiveVersion: number;
  format: typeof LIBRARY_ARCHIVE_FORMAT;
  projects: LibraryArchiveProjectEntry[];
  folders: LibraryFolder[];
  placements: LibraryPlacement[];
}

export type LibraryOrganizationIssue = 'folder-cycle' | 'inconsistent';

export const findLibraryOrganizationIssue = (
  projectIds: readonly string[],
  folders: readonly LibraryFolder[],
  placements: readonly LibraryPlacement[]
): LibraryOrganizationIssue | null => {
  const projectIdSet = new Set(projectIds);
  const folderIdSet = new Set(folders.map(folder => folder.id));
  if (
    projectIdSet.size !== projectIds.length ||
    folderIdSet.size !== folders.length ||
    new Set(placements.map(placement => placement.projectId)).size !== placements.length ||
    placements.length !== projectIds.length ||
    folders.some(
      folder => folder.parentFolderId !== null && !folderIdSet.has(folder.parentFolderId)
    ) ||
    placements.some(
      placement =>
        !projectIdSet.has(placement.projectId) ||
        (placement.folderId !== null && !folderIdSet.has(placement.folderId))
    )
  ) {
    return 'inconsistent';
  }

  const folderById = new Map(folders.map(folder => [folder.id, folder]));
  for (const folder of folders) {
    const visited = new Set<string>();
    let current: LibraryFolder | undefined = folder;
    while (current?.parentFolderId) {
      if (visited.has(current.id)) return 'folder-cycle';
      visited.add(current.id);
      current = folderById.get(current.parentFolderId);
    }
  }
  return null;
};

export type LibraryExportStatus = 'cancelled' | 'completed' | 'downloaded' | 'failed' | 'running';

export type LibraryExportPhase =
  | 'preparing'
  | 'project-archive'
  | 'library-archive'
  | 'integrity-check'
  | 'ready'
  | 'failed';

export interface LibraryExportProgress {
  archiveBytes?: number;
  bytesWritten: number;
  completedProjectCount: number;
  correlationId: string;
  currentProjectId?: string;
  errorCode?: string;
  errorPhase?: LibraryExportPhase;
  phase: LibraryExportPhase;
  projectCount: number;
  runId: string;
  status: LibraryExportStatus;
}

const sanitizeArchivePathSegment = (value: string): string => {
  const normalized = value.trim().replaceAll(/[^a-zA-Z0-9._-]+/g, '_');
  return normalized || 'course';
};

export const getLibraryArchiveProjectPath = (projectId: string, projectIndex: number): string =>
  `${LIBRARY_ARCHIVE_PROJECTS_DIR}/${String(projectIndex + 1).padStart(3, '0')}-${sanitizeArchivePathSegment(projectId)}.nous.zip`;
