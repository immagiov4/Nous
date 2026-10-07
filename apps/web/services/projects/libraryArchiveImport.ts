import {
  type LibraryArchiveData,
  LibraryArchiveError,
  type LibraryArchiveImportedProject,
  type LibraryArchiveImportResult,
  LibraryArchivePartialImportError,
  type LibraryArchiveProjectReference,
  type LibraryArchiveRejectedProject,
  LibraryArchiveRollbackError,
  readLibraryArchive,
  restoreLibraryArchiveOrganization,
} from './libraryArchive.ts';
import type { ProjectRepository } from './projectRepository';
import { createProjectId } from './projectSnapshot';

const sortRejectedProjectsByPosition = (projects: LibraryArchiveRejectedProject[]) =>
  projects.slice().sort((left, right) => left.projectIndex - right.projectIndex);

type LibraryArchiveProject = LibraryArchiveData['projectArchives'][number];

type LibraryArchiveProjectImportOutcome =
  | { importedProject: LibraryArchiveImportedProject; kind: 'imported' }
  | {
      cleanupFailed: boolean;
      kind: 'rejected';
      rejectedProject: LibraryArchiveRejectedProject;
    };

const warnLibraryArchiveProjectRollbackFailed = ({
  error,
  importedProjectId,
  projectId,
  projectIndex,
}: {
  error: unknown;
  importedProjectId: string;
  projectId: string;
  projectIndex: number;
}): void => {
  console.warn('[Nous] Failed to roll back an imported library project.', {
    error,
    importedProjectId,
    projectId,
    projectIndex,
  });
};

const importLibraryArchiveProject = async (
  repository: ProjectRepository,
  project: LibraryArchiveProject
): Promise<LibraryArchiveProjectImportOutcome> => {
  const importedProjectId = createProjectId();
  let cleanupProjectId = importedProjectId;
  try {
    const imported = await repository.importProjectArchive(project.archive, importedProjectId);
    cleanupProjectId = imported.snapshot.id;
    if (imported.snapshot.id !== importedProjectId) {
      throw new Error('Il server ha restituito un identificatore corso inatteso.');
    }
    return {
      importedProject: {
        id: project.id,
        importedProjectId,
        projectCount: project.projectCount,
        projectIndex: project.projectIndex,
        title: project.title,
      },
      kind: 'imported',
    };
  } catch (error) {
    console.warn('[Nous] Failed to import a course from a library archive.', {
      error,
      projectId: project.id,
      projectIndex: project.projectIndex,
    });
    const rejectedProject: LibraryArchiveRejectedProject = {
      code: 'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
      id: project.id,
      projectCount: project.projectCount,
      projectIndex: project.projectIndex,
      stage: 'project-import',
      title: project.title,
    };
    try {
      await repository.deleteProject(cleanupProjectId);
      return { cleanupFailed: false, kind: 'rejected', rejectedProject };
    } catch (cleanupError) {
      warnLibraryArchiveProjectRollbackFailed({
        error: cleanupError,
        importedProjectId: cleanupProjectId,
        projectId: project.id,
        projectIndex: project.projectIndex,
      });
      return { cleanupFailed: true, kind: 'rejected', rejectedProject };
    }
  }
};

const buildLibraryArchiveImportResult = ({
  importedProjects,
  notAttemptedProjects = [],
  rejectedProjects,
}: {
  importedProjects: LibraryArchiveImportedProject[];
  notAttemptedProjects?: LibraryArchiveProjectReference[];
  rejectedProjects: LibraryArchiveRejectedProject[];
}): LibraryArchiveImportResult => ({
  importedProjects,
  notAttemptedProjects,
  rejectedProjects: sortRejectedProjectsByPosition(rejectedProjects),
});

const rollbackImportedLibraryProjects = async (
  repository: ProjectRepository,
  importedProjects: LibraryArchiveImportedProject[]
): Promise<Set<string>> => {
  const retainedImportedProjectIds = new Set<string>();
  for (const project of importedProjects.slice().reverse()) {
    try {
      await repository.deleteProject(project.importedProjectId);
    } catch (cleanupError) {
      retainedImportedProjectIds.add(project.importedProjectId);
      warnLibraryArchiveProjectRollbackFailed({
        error: cleanupError,
        importedProjectId: project.importedProjectId,
        projectId: project.id,
        projectIndex: project.projectIndex,
      });
    }
  }
  return retainedImportedProjectIds;
};

const restoreImportedLibraryOrganization = async (
  repository: ProjectRepository,
  archive: LibraryArchiveData,
  projectIdMap: ReadonlyMap<string, string>
): Promise<void> => {
  if (projectIdMap.size === 0) return;
  await restoreLibraryArchiveOrganization(
    repository,
    {
      folders: archive.folders,
      placements: archive.placements.filter(placement => projectIdMap.has(placement.projectId)),
    },
    projectIdMap
  );
};

const refreshLibraryAfterIncompleteRollback = async (
  refreshLibraryState: () => Promise<void>
): Promise<void> => {
  try {
    await refreshLibraryState();
  } catch (refreshError) {
    console.warn(
      '[Nous] Failed to refresh the library after an incomplete rollback.',
      refreshError
    );
  }
};

const importLibraryArchiveProjects = async ({
  archive,
  refreshLibraryState,
  repository,
}: {
  archive: LibraryArchiveData;
  refreshLibraryState: () => Promise<void>;
  repository: ProjectRepository;
}): Promise<{
  importedProjects: LibraryArchiveImportedProject[];
  projectIdMap: Map<string, string>;
  rejectedProjects: LibraryArchiveRejectedProject[];
}> => {
  const projectIdMap = new Map<string, string>();
  const importedProjects: LibraryArchiveImportedProject[] = [];
  const rejectedProjects = [...archive.rejectedProjects];

  for (const [projectOffset, project] of archive.projectArchives.entries()) {
    const outcome = await importLibraryArchiveProject(repository, project);
    if (outcome.kind === 'imported') {
      projectIdMap.set(project.id, outcome.importedProject.importedProjectId);
      importedProjects.push(outcome.importedProject);
      continue;
    }
    rejectedProjects.push(outcome.rejectedProject);
    if (!outcome.cleanupFailed) continue;

    const result = buildLibraryArchiveImportResult({
      importedProjects,
      notAttemptedProjects: archive.projectArchives
        .slice(projectOffset + 1)
        .map(notAttemptedProject => ({
          id: notAttemptedProject.id,
          projectCount: notAttemptedProject.projectCount,
          projectIndex: notAttemptedProject.projectIndex,
          title: notAttemptedProject.title,
        })),
      rejectedProjects,
    });
    try {
      await restoreImportedLibraryOrganization(repository, archive, projectIdMap);
    } catch (organizationError) {
      console.warn(
        '[Nous] Failed to restore library organization after an incomplete project rollback.',
        organizationError
      );
    }
    await refreshLibraryAfterIncompleteRollback(refreshLibraryState);
    throw new LibraryArchiveRollbackError(project.projectIndex, project.projectCount, result);
  }

  return { importedProjects, projectIdMap, rejectedProjects };
};

const restoreLibraryOrganizationOrRollbackProjects = async ({
  archive,
  importedProjects,
  projectIdMap,
  refreshLibraryState,
  rejectedProjects,
  repository,
}: {
  archive: LibraryArchiveData;
  importedProjects: LibraryArchiveImportedProject[];
  projectIdMap: ReadonlyMap<string, string>;
  refreshLibraryState: () => Promise<void>;
  rejectedProjects: LibraryArchiveRejectedProject[];
  repository: ProjectRepository;
}): Promise<void> => {
  try {
    await restoreImportedLibraryOrganization(repository, archive, projectIdMap);
  } catch (error) {
    const retainedImportedProjectIds = await rollbackImportedLibraryProjects(
      repository,
      importedProjects
    );
    const rollbackFailed =
      error instanceof LibraryArchiveRollbackError || retainedImportedProjectIds.size > 0;
    if (!rollbackFailed) throw error;

    await refreshLibraryAfterIncompleteRollback(refreshLibraryState);
    const projectCount =
      error instanceof LibraryArchiveError
        ? (error.projectCount ?? archive.projectCount)
        : archive.projectCount;
    throw new LibraryArchiveRollbackError(
      error instanceof LibraryArchiveError ? error.projectIndex : undefined,
      projectCount,
      buildLibraryArchiveImportResult({
        importedProjects: importedProjects.filter(project =>
          retainedImportedProjectIds.has(project.importedProjectId)
        ),
        rejectedProjects,
      })
    );
  }
};

/**
 * Outcome of a library archive import whose courses and organization were committed.
 * `refresh-failed` means the library could not be reloaded afterwards; callers report
 * the error without treating the import itself as failed.
 */
export type LibraryArchiveImportOutcome =
  | { readonly importedProjectCount: number; readonly kind: 'imported' }
  | { readonly error: unknown; readonly kind: 'refresh-failed' };

/**
 * Imports every course of a library archive, restores its folder organization and
 * refreshes the library. A rejected course keeps the courses already imported and
 * surfaces as a partial-import error after the refresh. A failed organization restore
 * rolls back the imported courses; only an incomplete rollback refreshes the library
 * before throwing.
 */
export const importLibraryArchive = async ({
  file,
  refreshLibraryState,
  repository,
}: {
  file: File;
  refreshLibraryState: () => Promise<void>;
  repository: ProjectRepository;
}): Promise<LibraryArchiveImportOutcome> => {
  const archive = await readLibraryArchive(file);
  const { importedProjects, projectIdMap, rejectedProjects } = await importLibraryArchiveProjects({
    archive,
    refreshLibraryState,
    repository,
  });
  await restoreLibraryOrganizationOrRollbackProjects({
    archive,
    importedProjects,
    projectIdMap,
    refreshLibraryState,
    rejectedProjects,
    repository,
  });
  const partialImportError =
    rejectedProjects.length > 0
      ? new LibraryArchivePartialImportError(
          buildLibraryArchiveImportResult({ importedProjects, rejectedProjects })
        )
      : null;
  try {
    await refreshLibraryState();
  } catch (refreshError) {
    if (!partialImportError) return { error: refreshError, kind: 'refresh-failed' };
    console.warn('[Nous] Failed to refresh the library after a partial import.', refreshError);
  }
  if (partialImportError) throw partialImportError;
  return { importedProjectCount: importedProjects.length, kind: 'imported' };
};
