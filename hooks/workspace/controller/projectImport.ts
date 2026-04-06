import {
  isProjectArchiveFile,
  readProjectImportData,
} from '../../../services/projects/projectArchive.ts';
import { prepareSnapshotForHydration } from '../../../services/workspace/controller/snapshotHydration.ts';
import type { ProjectSnapshot } from '../../../types.ts';
import type { WorkspaceControllerContext } from './types.ts';

const persistPreparedSnapshotIfChanged = async (
  context: Pick<WorkspaceControllerContext, 'projectLibrary'>,
  originalSnapshot: ProjectSnapshot,
  preparedSnapshot: ProjectSnapshot
) => {
  if (JSON.stringify(preparedSnapshot) === JSON.stringify(originalSnapshot)) {
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
  const preparedSnapshot = prepareSnapshotForHydration(snapshot);

  await persistPreparedSnapshotIfChanged(context, snapshot, preparedSnapshot);
  context.persistHydratedSnapshot(preparedSnapshot);
  await context.projectLibrary.touchStoredProject(preparedSnapshot.id);
  await context.projectLibrary.refreshLibraryState();

  return preparedSnapshot;
};

export const isLuminaBackupArchive = async (selectedFile: File): Promise<boolean> =>
  isProjectArchiveFile(selectedFile);
