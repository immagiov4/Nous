import { insertMovedSiblingItems, type SiblingItem } from '@shared/libraryOrdering';
import { describe, expect, test } from 'vitest';

const createSibling = (id: string, kind: SiblingItem['kind'], order: number): SiblingItem =>
  kind === 'folder'
    ? {
        id,
        kind,
        value: {
          createdAt: '2026-07-07T10:00:00.000Z',
          id,
          name: id,
          order,
          parentFolderId: null,
          updatedAt: '2026-07-07T10:00:00.000Z',
        },
      }
    : {
        id,
        kind,
        value: {
          folderId: null,
          order,
          projectId: id,
          updatedAt: '2026-07-07T10:00:00.000Z',
        },
      };

describe('insertMovedSiblingItems', () => {
  test.each([
    { movedKind: 'project' as const, retainedKind: 'folder' as const },
    { movedKind: 'folder' as const, retainedKind: 'project' as const },
  ])('retains a $retainedKind when a moved $movedKind has the same ID', ({
    movedKind,
    retainedKind,
  }) => {
    const retainedSibling = createSibling('shared-id', retainedKind, 1024);
    const movedSibling = createSibling('shared-id', movedKind, 2048);

    expect(
      insertMovedSiblingItems([retainedSibling, movedSibling], 0, [movedSibling]).map(item => ({
        id: item.id,
        kind: item.kind,
      }))
    ).toEqual([
      { id: 'shared-id', kind: movedKind },
      { id: 'shared-id', kind: retainedKind },
    ]);
  });
});
