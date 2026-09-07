import { findLibraryOrganizationIssue } from '@shared/libraryExportContract';
import type { LibraryFolder } from '@shared/projectContract';
import { expect, test } from 'vitest';

const buildFolder = (id: string, parentFolderId: string | null): LibraryFolder => ({
  id,
  parentFolderId,
  name: id,
  order: 0,
  createdAt: '2026-09-07T00:00:00Z',
  updatedAt: '2026-09-07T00:00:00Z',
});

test('validates a deep folder chain without repeatedly walking its checked ancestors', () => {
  const folderCount = 128;
  let parentReads = 0;
  const folders = Array.from({ length: folderCount }, (_, index) => {
    const parentFolderId = index === 0 ? null : `folder-${index - 1}`;
    const folder = buildFolder(`folder-${index}`, parentFolderId);
    Object.defineProperty(folder, 'parentFolderId', {
      get: () => {
        parentReads += 1;
        return parentFolderId;
      },
    });
    return folder;
  });
  expect(findLibraryOrganizationIssue([], folders, [])).toBeNull();
  const maximumParentReadsPerFolder = 4;
  expect(parentReads).toBeLessThanOrEqual(folderCount * maximumParentReadsPerFolder);
});

test('distinguishes shared ancestors from cycles reached through another branch', () => {
  const root = buildFolder('root', null);
  const branch = buildFolder('branch', 'root');
  const sibling = buildFolder('sibling', 'root');
  expect(findLibraryOrganizationIssue([], [branch, sibling, root], [])).toBeNull();
  root.parentFolderId = 'branch';
  expect(findLibraryOrganizationIssue([], [sibling, root, branch], [])).toBe('folder-cycle');
});
