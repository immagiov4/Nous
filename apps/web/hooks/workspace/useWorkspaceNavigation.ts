import { useCallback, useEffect, useRef, useState } from 'react';
import { pushNousDebugTrace } from '../../services/core/debugTrace.ts';
import { AppState } from '../../types.ts';
import {
  buildProjectLocationHref,
  getProjectIdFromLocation,
} from '../../utils/project/location.ts';

interface OpenProjectResult {
  outcome: string;
  errorMessage?: string;
}

interface OpenProjectNavigationOptions {
  activeSectionId?: string;
  source?: 'library' | 'route';
}

interface UseWorkspaceNavigationArgs {
  currentProjectId: string | null;
  isLibraryLoading: boolean;
  notifyError: (message: string) => void;
  onGoToLibrary: () => Promise<void>;
  onOpenProject: (
    projectId: string,
    options?: { activeSectionId?: string }
  ) => Promise<OpenProjectResult>;
  openingProjectId: string | null;
  screenState: AppState;
  setIsFocusMode: (value: boolean) => void;
  setIsMobileSidebarOpen: (value: boolean) => void;
}

interface ShouldOpenProjectFromLocationArgs {
  currentProjectId: string | null;
  hasPendingExternalLocation: boolean;
  locationProjectId: string;
  openingProjectId: string | null;
  screenState: AppState;
}

export const shouldOpenProjectFromLocation = ({
  currentProjectId,
  hasPendingExternalLocation,
  locationProjectId,
  openingProjectId,
  screenState,
}: ShouldOpenProjectFromLocationArgs): boolean => {
  if (openingProjectId === locationProjectId) {
    return false;
  }

  if (
    screenState === AppState.LIBRARY &&
    !hasPendingExternalLocation &&
    locationProjectId === currentProjectId
  ) {
    return false;
  }

  if (locationProjectId === currentProjectId && screenState !== AppState.LIBRARY) {
    return false;
  }

  return true;
};

export const useWorkspaceNavigation = ({
  currentProjectId,
  isLibraryLoading,
  notifyError,
  onGoToLibrary,
  onOpenProject,
  openingProjectId,
  screenState,
  setIsFocusMode,
  setIsMobileSidebarOpen,
}: UseWorkspaceNavigationArgs) => {
  const [locationProjectId, setLocationProjectId] = useState<string | null>(() =>
    typeof globalThis.window === 'undefined' ? null : getProjectIdFromLocation(globalThis.location)
  );
  const hasPendingExternalLocationRef = useRef(Boolean(locationProjectId));
  const nextLocationHistoryModeRef = useRef<'push' | 'replace'>('replace');

  const syncProjectLocation = useCallback(
    (projectId: string | null, historyMode: 'push' | 'replace' = 'replace') => {
      if (typeof globalThis.window === 'undefined') {
        return;
      }

      const nextHref = buildProjectLocationHref(globalThis.location, projectId);
      const currentHref = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;

      if (nextHref !== currentHref) {
        globalThis.history[historyMode === 'push' ? 'pushState' : 'replaceState']({}, '', nextHref);
      }

      hasPendingExternalLocationRef.current = false;
      setLocationProjectId(projectId);
    },
    []
  );

  const handleBackToLibrary = useCallback(() => {
    pushNousDebugTrace('navigation:back-to-library', {
      currentProjectId,
      screenState,
    });
    nextLocationHistoryModeRef.current = 'replace';
    setIsFocusMode(false);
    setIsMobileSidebarOpen(false);
    void onGoToLibrary();
  }, [currentProjectId, onGoToLibrary, screenState, setIsFocusMode, setIsMobileSidebarOpen]);

  const handleOpenProject = useCallback(
    async (projectId: string, options?: OpenProjectNavigationOptions) => {
      pushNousDebugTrace('navigation:open-project', {
        currentProjectId,
        locationProjectId,
        openingProjectId,
        projectId,
        activeSectionId: options?.activeSectionId,
        screenState,
        source: options?.source || 'route',
      });
      if (options?.source === 'library') {
        nextLocationHistoryModeRef.current = 'push';
      }

      const result = await onOpenProject(projectId, {
        activeSectionId: options?.activeSectionId,
      });
      pushNousDebugTrace('navigation:open-project-result', {
        errorMessage: result.errorMessage,
        outcome: result.outcome,
        projectId,
        source: options?.source || 'route',
      });
      if (result.outcome === 'missing' && options?.source === 'route') {
        syncProjectLocation(null, 'replace');
        return result;
      }

      if (result.outcome === 'opened') {
        setIsMobileSidebarOpen(false);
      }

      if (result.errorMessage) {
        notifyError(result.errorMessage);
      }
      return result;
    },
    [
      currentProjectId,
      locationProjectId,
      notifyError,
      onOpenProject,
      openingProjectId,
      screenState,
      setIsMobileSidebarOpen,
      syncProjectLocation,
    ]
  );

  useEffect(() => {
    const handlePopState = () => {
      hasPendingExternalLocationRef.current = true;
      setLocationProjectId(getProjectIdFromLocation(globalThis.location));
    };

    globalThis.addEventListener('popstate', handlePopState);
    return () => {
      globalThis.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (isLibraryLoading) {
      return;
    }

    if (!locationProjectId) {
      if (hasPendingExternalLocationRef.current && screenState !== AppState.LIBRARY) {
        handleBackToLibrary();
      }

      hasPendingExternalLocationRef.current = false;
      return;
    }

    if (
      !shouldOpenProjectFromLocation({
        currentProjectId,
        hasPendingExternalLocation: hasPendingExternalLocationRef.current,
        locationProjectId,
        openingProjectId,
        screenState,
      })
    ) {
      if (locationProjectId === currentProjectId && screenState !== AppState.LIBRARY) {
        hasPendingExternalLocationRef.current = false;
      }
      return;
    }

    void handleOpenProject(locationProjectId, { source: 'route' });
  }, [
    currentProjectId,
    handleBackToLibrary,
    handleOpenProject,
    isLibraryLoading,
    locationProjectId,
    openingProjectId,
    screenState,
  ]);

  useEffect(() => {
    const expectedProjectId = screenState === AppState.LIBRARY ? null : currentProjectId;
    if (hasPendingExternalLocationRef.current && locationProjectId !== expectedProjectId) {
      return;
    }

    syncProjectLocation(expectedProjectId, nextLocationHistoryModeRef.current);
    nextLocationHistoryModeRef.current = 'replace';
  }, [currentProjectId, locationProjectId, screenState, syncProjectLocation]);

  return {
    handleBackToLibrary,
    handleOpenProject,
  };
};
