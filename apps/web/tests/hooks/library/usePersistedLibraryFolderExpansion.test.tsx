// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { usePersistedLibraryFolderExpansion } from '../../../hooks/library/usePersistedLibraryFolderExpansion.ts';
import { LIBRARY_COLLAPSED_FOLDER_IDS_KEY } from '../../../services/preferences/libraryFolderExpansionStorage.ts';
import type { LibraryTree } from '../../../types.ts';

const buildTree = (folderIds: string[]): Pick<LibraryTree, 'folderById'> => ({
  folderById: Object.fromEntries(
    folderIds.map((folderId, index) => [
      folderId,
      {
        id: folderId,
        name: `Cartella ${index + 1}`,
        parentFolderId: null,
        createdAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
        order: index + 1,
      },
    ])
  ),
});

beforeEach(() => {
  globalThis.localStorage.clear();
});

test('persists multiple folder expansion toggles immediately', () => {
  globalThis.localStorage.setItem(
    LIBRARY_COLLAPSED_FOLDER_IDS_KEY,
    JSON.stringify(['folder-1', 'folder-2'])
  );

  const { result } = renderHook(() =>
    usePersistedLibraryFolderExpansion(buildTree(['folder-1', 'folder-2']))
  );

  expect(result.current.expandedFolderIds.has('folder-1')).toBe(false);
  expect(result.current.expandedFolderIds.has('folder-2')).toBe(false);

  act(() => {
    result.current.toggleFolderExpansion('folder-1');
  });

  expect(
    JSON.parse(globalThis.localStorage.getItem(LIBRARY_COLLAPSED_FOLDER_IDS_KEY) || '[]')
  ).toEqual(['folder-2']);

  act(() => {
    result.current.toggleFolderExpansion('folder-2');
  });

  expect(
    JSON.parse(globalThis.localStorage.getItem(LIBRARY_COLLAPSED_FOLDER_IDS_KEY) || '[]')
  ).toEqual([]);
});
