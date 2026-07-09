import {
  isProjectArchiveFile,
  readProjectImportData,
} from '../../../services/projects/projectArchive.ts';
import { prepareSnapshotForHydrationResult } from '../../../services/workspace/controller/snapshotHydration.ts';
import type { ProjectSnapshot } from '../../../types.ts';
import type { WorkspaceControllerContext } from './types.ts';

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

export const importProjectBackupFile = async (
  context: Pick<WorkspaceControllerContext, 'persistHydratedSnapshot' | 'projectLibrary'>,
  selectedFile: File
): Promise<ProjectSnapshot> => {
  const importedProject = await readProjectImportData(selectedFile);
  const { snapshot } = await context.projectLibrary.importProjectData(importedProject);
  const hydration = prepareSnapshotForHydrationResult(snapshot);
  const preparedSnapshot = hydration.snapshot;

  await persistPreparedSnapshotIfChanged(context, preparedSnapshot, hydration.didChange);
  context.persistHydratedSnapshot(preparedSnapshot);
  await context.projectLibrary.touchStoredProject(preparedSnapshot.id);
  await context.projectLibrary.refreshLibraryState();

  return preparedSnapshot;
};

export const isNousBackupArchive = async (selectedFile: File): Promise<boolean> =>
  isProjectArchiveFile(selectedFile);
