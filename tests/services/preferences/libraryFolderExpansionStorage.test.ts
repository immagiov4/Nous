import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  LIBRARY_COLLAPSED_FOLDER_IDS_KEY,
  parseCollapsedLibraryFolderIds,
  readCollapsedLibraryFolderIds,
  writeCollapsedLibraryFolderIds,
} from '../../../services/preferences/libraryFolderExpansionStorage.ts';

test('parseCollapsedLibraryFolderIds keeps only non-empty unique folder ids', () => {
  assert.deepEqual(
    parseCollapsedLibraryFolderIds(JSON.stringify([' folder-1 ', '', 'folder-2', 'folder-1'])),
    ['folder-1', 'folder-2']
  );
});

test('parseCollapsedLibraryFolderIds returns an empty list for invalid payloads', () => {
  assert.deepEqual(parseCollapsedLibraryFolderIds('{not-json'), []);
  assert.deepEqual(parseCollapsedLibraryFolderIds(JSON.stringify({ folderId: 'folder-1' })), []);
});

test('readCollapsedLibraryFolderIds and writeCollapsedLibraryFolderIds use the shared storage key', () => {
  const storedValues = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storedValues.set(key, value);
    },
  };

  writeCollapsedLibraryFolderIds(storage, ['folder-1', 'folder-2']);

  assert.equal(storedValues.has(LIBRARY_COLLAPSED_FOLDER_IDS_KEY), true);
  assert.deepEqual(readCollapsedLibraryFolderIds(storage), ['folder-1', 'folder-2']);
});
