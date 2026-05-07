import type { LibraryFolder } from '../../types.ts';

const DEFAULT_FOLDER_NAME = 'Nuova cartella';

const normalizeFolderName = (name: string) => name.trim() || DEFAULT_FOLDER_NAME;

const normalizeFolderNameKey = (name: string) => normalizeFolderName(name).toLocaleLowerCase();

const buildFolderNameCandidate = (baseName: string, suffixIndex: number) =>
  suffixIndex === 1 ? baseName : `${baseName} (${suffixIndex})`;

export const resolveAvailableFolderName = (
  requestedName: string,
  folders: LibraryFolder[],
  parentFolderId: string | null,
  ignoredFolderId?: string
) => {
  const baseName = normalizeFolderName(requestedName);
  const siblingNameKeys = new Set(
    folders
      .filter(folder => folder.parentFolderId === parentFolderId && folder.id !== ignoredFolderId)
      .map(folder => normalizeFolderNameKey(folder.name))
  );

  let suffixIndex = 1;
  let candidate = baseName;
  while (siblingNameKeys.has(normalizeFolderNameKey(candidate))) {
    suffixIndex += 1;
    candidate = buildFolderNameCandidate(baseName, suffixIndex);
  }

  return candidate;
};
