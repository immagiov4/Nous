import {
  hasZipFileSignature,
  inspectProjectArchiveData,
  isProjectArchiveFile,
  readLegacyProjectImportData,
} from '../../../services/projects/projectArchive.ts';
import { createProjectId } from '../../../services/projects/projectSnapshot.ts';
import { prepareSnapshotForHydrationResult } from '../../../services/workspace/controller/snapshotHydration.ts';
import type { AppState, ProjectSnapshot } from '../../../types.ts';
import type { WorkspaceControllerContext } from './types.ts';

type ProjectImportContext = Pick<
  WorkspaceControllerContext,
  'domain' | 'persistHydratedSnapshot' | 'projectLibrary' | 'state'
>;

interface PreviousWorkspaceState {
  screenState: AppState;
  snapshot: ProjectSnapshot | null;
}

const hasProjectArchiveExtension = (file: File): boolean =>
  file.name.toLowerCase().endsWith('.nous.zip');

const persistPreparedSnapshotIfChanged = async (
  context: Pick<WorkspaceControllerContext, 'projectLibrary'>,
  preparedSnapshot: ProjectSnapshot,
  didChange: boolean
) => {
  if (!didChange) {
    return;
  }

  await context.projectLibrary.persistSnapshot(preparedSnapshot);
};

const captureCurrentWorkspaceSnapshot = async (
  context: ProjectImportContext
): Promise<PreviousWorkspaceState> => {
  const projectId = context.projectLibrary.getCurrentProjectId();
  const storedSnapshot = projectId
    ? await context.projectLibrary.loadStoredProject(projectId)
    : null;
  return {
    screenState: context.state.getScreenState(),
    snapshot: storedSnapshot ? { ...storedSnapshot, ...context.domain.domainState } : null,
  };
};

const restoreWorkspaceAfterFailedImport = (
  context: ProjectImportContext,
  previousWorkspace: PreviousWorkspaceState
): void => {
  if (previousWorkspace.snapshot) {
    context.persistHydratedSnapshot(previousWorkspace.snapshot);
  } else {
    context.projectLibrary.setCurrentProjectId(null);
    context.domain.resetDomain();
    context.state.resetSessionState();
  }
  context.state.setScreenState(previousWorkspace.screenState);
};

const rollbackFailedArchiveImport = async (
  context: ProjectImportContext,
  archiveTargetProjectId: string | undefined,
  previousWorkspace: PreviousWorkspaceState | null,
  didHydrateImportedSnapshot: boolean
): Promise<void> => {
  if (!archiveTargetProjectId) return;

  try {
    await context.projectLibrary.deleteStoredProject(archiveTargetProjectId);
  } catch (cleanupError) {
    console.error('[Projects] Failed to roll back an incomplete project import.', {
      projectId: archiveTargetProjectId,
      rollbackError: cleanupError,
    });
    throw new Error('Importazione non riuscita e rimozione del corso incompleta.');
  } finally {
    if (didHydrateImportedSnapshot && previousWorkspace) {
      restoreWorkspaceAfterFailedImport(context, previousWorkspace);
    }
  }
};

export const importProjectBackupFile = async (
  context: ProjectImportContext,
  selectedFile: File
): Promise<ProjectSnapshot> => {
  const archiveProject = (await hasZipFileSignature(selectedFile))
    ? await inspectProjectArchiveData(selectedFile)
    : null;
  const previousWorkspace = archiveProject ? await captureCurrentWorkspaceSnapshot(context) : null;
  let archiveTargetProjectId: string | undefined;
  let didHydrateImportedSnapshot = false;
  let imported: Awaited<
    ReturnType<WorkspaceControllerContext['projectLibrary']['importProjectData']>
  >;
  try {
    if (archiveProject) {
      if (typeof archiveProject.id !== 'string' || !archiveProject.id.trim()) {
        throw new Error('Il backup contiene un corso senza identificatore.');
      }
      archiveTargetProjectId = createProjectId();
      imported = await context.projectLibrary.importProjectArchive(
        selectedFile,
        archiveTargetProjectId
      );
    } else {
      imported = await context.projectLibrary.importProjectData(
        await readLegacyProjectImportData(selectedFile)
      );
    }
    if (!imported) {
      throw new Error('Importazione del corso non riuscita.');
    }
    const { snapshot } = imported;
    const hydration = prepareSnapshotForHydrationResult(snapshot);
    const preparedSnapshot = hydration.snapshot;

    await persistPreparedSnapshotIfChanged(context, preparedSnapshot, hydration.didChange);
    context.persistHydratedSnapshot(preparedSnapshot);
    didHydrateImportedSnapshot = true;
    await context.projectLibrary.touchStoredProject(preparedSnapshot.id);
    await context.projectLibrary.refreshLibraryState();

    return preparedSnapshot;
  } catch (error) {
    await rollbackFailedArchiveImport(
      context,
      archiveTargetProjectId,
      previousWorkspace,
      didHydrateImportedSnapshot
    );
    throw error;
  }
};

export const isNousBackupArchive = async (selectedFile: File): Promise<boolean> =>
  hasProjectArchiveExtension(selectedFile) && isProjectArchiveFile(selectedFile);
