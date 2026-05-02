import type { LibraryFolder, LibraryPlacement } from '../../types.ts';

export const SIBLING_ORDER_STEP = 1024;

export type SiblingItem =
  | { id: string; kind: 'folder'; value: LibraryFolder }
  | { id: string; kind: 'project'; value: LibraryPlacement };

/**
 * Build a sorted list of sibling items (folders + project placements)
 * sharing the same parent folder.
 */
export const buildOrderedSiblingItems = (
  folders: LibraryFolder[],
  placements: LibraryPlacement[],
  parentFolderId: string | null
): SiblingItem[] =>
  [
    ...folders
      .filter(folder => folder.parentFolderId === parentFolderId)
      .map(folder => ({ id: folder.id, kind: 'folder' as const, value: folder })),
    ...placements
      .filter(placement => placement.folderId === parentFolderId)
      .map(placement => ({
        id: placement.projectId,
        kind: 'project' as const,
        value: placement,
      })),
  ].sort((left, right) => {
    if (left.value.order !== right.value.order) {
      return left.value.order - right.value.order;
    }

    if (left.kind !== right.kind) {
      return left.kind === 'folder' ? -1 : 1;
    }

    return left.id.localeCompare(right.id, 'it', { sensitivity: 'base' });
  });

/**
 * Compute the stable insertion index when moving items to a new parent,
 * accounting for already-moved items that are temporarily removed from the list.
 */
export const resolveInsertionIndex = (
  originalSiblingItems: Array<{ id: string }>,
  movingIds: Set<string>,
  targetIndex: number | undefined,
  filteredSiblingCount: number
): number => {
  if (typeof targetIndex !== 'number' || Number.isNaN(targetIndex)) {
    return filteredSiblingCount;
  }

  const boundedTargetIndex = Math.max(
    0,
    Math.min(filteredSiblingCount + movingIds.size, Math.trunc(targetIndex))
  );
  const removedBeforeTarget = originalSiblingItems
    .slice(0, boundedTargetIndex)
    .filter(item => movingIds.has(item.id)).length;

  return Math.max(0, Math.min(filteredSiblingCount, boundedTargetIndex - removedBeforeTarget));
};

/**
 * Insert moved items into the destination sibling list at the resolved index,
 * returning a new array.
 */
const insertMovedSiblingItems = (
  destinationItems: SiblingItem[],
  movingIds: Set<string>,
  targetIndex: number | undefined,
  movedItems: SiblingItem[]
): SiblingItem[] => {
  const retainedItems = destinationItems.filter(item => !movingIds.has(item.id));
  const insertionIndex = resolveInsertionIndex(
    destinationItems,
    movingIds,
    targetIndex,
    retainedItems.length
  );

  retainedItems.splice(insertionIndex, 0, ...movedItems);
  return retainedItems;
};

/**
 * Compute the next free order value for a new folder or placement.
 */
const resolveNextOrder = (
  siblingOrders: number[],
  step = SIBLING_ORDER_STEP
): number =>
  (Math.max(0, ...siblingOrders) || 0) + step;

/**
 * Compute the next placement order from a list of existing placements.
 */
export const resolveNextPlacementOrder = (
  placements: LibraryPlacement[],
  folderId: string | null,
  step = SIBLING_ORDER_STEP
): number =>
  resolveNextOrder(
    placements
      .filter(placement => placement.folderId === folderId)
      .map(placement => placement.order),
    step
  );

/**
 * Compute the next folder order from a list of existing folders.
 */
export const resolveNextFolderOrder = (
  folders: LibraryFolder[],
  parentFolderId: string | null,
  step = SIBLING_ORDER_STEP
): number =>
  resolveNextOrder(
    folders
      .filter(folder => folder.parentFolderId === parentFolderId)
      .map(folder => folder.order),
    step
  );

/**
 * Collect all descendant folder IDs via BFS from a root folder,
 * given the full folder list.
 */
export const collectFolderDescendantIds = (
  folders: LibraryFolder[],
  folderId: string
): Set<string> => {
  const childFolderIdsByParent = new Map<string, string[]>();

  for (const folder of folders) {
    const parentFolderId = folder.parentFolderId || '';
    const childIds = childFolderIdsByParent.get(parentFolderId) || [];
    childIds.push(folder.id);
    childFolderIdsByParent.set(parentFolderId, childIds);
  }

  const descendantIds = new Set<string>();
  const queue = [folderId];

  while (queue.length > 0) {
    const currentFolderId = queue.shift();
    if (!currentFolderId || descendantIds.has(currentFolderId)) {
      continue;
    }

    descendantIds.add(currentFolderId);
    for (const childFolderId of childFolderIdsByParent.get(currentFolderId) || []) {
      if (!descendantIds.has(childFolderId)) {
        queue.push(childFolderId);
      }
    }
  }

  return descendantIds;
};
