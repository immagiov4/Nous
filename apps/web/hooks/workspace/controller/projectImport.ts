import {
  isProjectArchiveFile,
  readProjectImportBundle,
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
  const importedProject = await readProjectImportBundle(selectedFile);
  const imported = importedProject.sourceArchiveFile
    ? await context.projectLibrary.persistSnapshot(importedProject.data as ProjectSnapshot, {
        archiveFile: importedProject.sourceArchiveFile,
        throwOnError: true,
      })
    : await context.projectLibrary.importProjectData(importedProject.data);
  if (!imported) {
    throw new Error('Importazione del corso non riuscita.');
  }
  const { snapshot } = imported;
  const hydration = prepareSnapshotForHydrationResult(snapshot);
  const preparedSnapshot = hydration.snapshot;

  await persistPreparedSnapshotIfChanged(context, preparedSnapshot, hydration.didChange);
  context.persistHydratedSnapshot(preparedSnapshot);
  await context.projectLibrary.touchStoredProject(preparedSnapshot.id);
  await context.projectLibrary.refreshLibraryState();

  return preparedSnapshot;
};

export const isNousBackupArchive = async (selectedFile: File): Promise<boolean> =>
  selectedFile.name.toLowerCase().endsWith('.nous.zip') && isProjectArchiveFile(selectedFile);
