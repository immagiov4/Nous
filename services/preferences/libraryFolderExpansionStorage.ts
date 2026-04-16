export const LIBRARY_COLLAPSED_FOLDER_IDS_KEY = 'lumina-library-collapsed-folder-ids';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const parseCollapsedLibraryFolderIds = (rawFolderIds: string | null): string[] => {
  if (!rawFolderIds) {
    return [];
  }

  try {
    const parsedFolderIds = JSON.parse(rawFolderIds) as unknown;
    if (!Array.isArray(parsedFolderIds)) {
      return [];
    }

    return [...new Set(parsedFolderIds.filter(isNonEmptyString).map(folderId => folderId.trim()))];
  } catch {
    return [];
  }
};

export const readCollapsedLibraryFolderIds = (
  storage: Partial<Pick<Storage, 'getItem'>> | null | undefined
): string[] => {
  if (typeof storage?.getItem !== 'function') {
    return [];
  }

  try {
    return parseCollapsedLibraryFolderIds(storage.getItem(LIBRARY_COLLAPSED_FOLDER_IDS_KEY));
  } catch {
    return [];
  }
};

export const writeCollapsedLibraryFolderIds = (
  storage: Partial<Pick<Storage, 'setItem'>> | null | undefined,
  folderIds: readonly string[]
) => {
  if (typeof storage?.setItem !== 'function') {
    return;
  }

  try {
    storage.setItem(LIBRARY_COLLAPSED_FOLDER_IDS_KEY, JSON.stringify(folderIds));
  } catch {
    // Best effort only.
  }
};
