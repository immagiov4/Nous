import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  readCollapsedLibraryFolderIds,
  writeCollapsedLibraryFolderIds,
} from '../../services/preferences/libraryFolderExpansionStorage.ts';
import type { LibraryTree } from '../../types.ts';

const areSetsEqual = (left: ReadonlySet<string>, right: ReadonlySet<string>) => {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
};

const buildExpandedFolderIds = (
  folderIds: readonly string[],
  collapsedFolderIds: readonly string[]
) => {
  const collapsedFolderIdSet = new Set(collapsedFolderIds);
  return new Set(folderIds.filter(folderId => !collapsedFolderIdSet.has(folderId)));
};

const persistCollapsedFolderIds = (
  folderIds: readonly string[],
  expandedFolderIds: ReadonlySet<string>
) => {
  if (typeof window === 'undefined') {
    return;
  }

  writeCollapsedLibraryFolderIds(
    window.localStorage,
    folderIds.filter(folderId => !expandedFolderIds.has(folderId))
  );
};

export const usePersistedLibraryFolderExpansion = (tree: Pick<LibraryTree, 'folderById'>) => {
  const folderIds = useMemo(() => Object.keys(tree.folderById), [tree.folderById]);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => {
    if (folderIds.length === 0) {
      return new Set<string>();
    }

    if (typeof window === 'undefined') {
      return new Set(folderIds);
    }

    return buildExpandedFolderIds(folderIds, readCollapsedLibraryFolderIds(window.localStorage));
  });
  const hasHydratedFromStorageRef = useRef(folderIds.length > 0);
  const previousFolderIdsRef = useRef<Set<string>>(new Set(folderIds));

  useEffect(() => {
    const previousFolderIds = previousFolderIdsRef.current;

    setExpandedFolderIds(currentIds => {
      if (!hasHydratedFromStorageRef.current && folderIds.length > 0) {
        hasHydratedFromStorageRef.current = true;
        const hydratedIds =
          typeof window === 'undefined'
            ? new Set(folderIds)
            : buildExpandedFolderIds(folderIds, readCollapsedLibraryFolderIds(window.localStorage));

        return areSetsEqual(currentIds, hydratedIds) ? currentIds : hydratedIds;
      }

      const nextIds = new Set<string>();
      folderIds.forEach(folderId => {
        if (!previousFolderIds.has(folderId) || currentIds.has(folderId)) {
          nextIds.add(folderId);
        }
      });

      return areSetsEqual(currentIds, nextIds) ? currentIds : nextIds;
    });

    previousFolderIdsRef.current = new Set(folderIds);
  }, [folderIds]);

  useEffect(() => {
    if (typeof window === 'undefined' || !hasHydratedFromStorageRef.current) {
      return;
    }

    persistCollapsedFolderIds(folderIds, expandedFolderIds);
  }, [expandedFolderIds, folderIds]);

  const toggleFolderExpansion = useCallback(
    (folderId: string) => {
      setExpandedFolderIds(currentIds => {
        const nextIds = new Set(currentIds);
        if (nextIds.has(folderId)) {
          nextIds.delete(folderId);
        } else {
          nextIds.add(folderId);
        }

        persistCollapsedFolderIds(folderIds, nextIds);
        return nextIds;
      });
    },
    [folderIds]
  );

  return {
    expandedFolderIds,
    setExpandedFolderIds,
    toggleFolderExpansion,
  };
};
