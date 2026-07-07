// fallow-ignore-file unused-files
/* @refresh reset */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { READER_MOBILE_LAYOUT_BREAKPOINT_PX } from '../../constants/layout.ts';
import { subscribeToMediaQuery } from '../../utils/mediaQuery.ts';
import { type ExpandedModuleState, resolveExpandedModuleState } from '../../utils/reader/chrome.ts';
import type { SidebarGroup } from '../../utils/reader/workspaceReader.ts';

const MOBILE_LAYOUT_MEDIA_QUERY = `(max-width: ${READER_MOBILE_LAYOUT_BREAKPOINT_PX - 1}px)`;

const keepCurrentWhenEqual =
  <T>(nextValue: T) =>
  (currentValue: T): T =>
    Object.is(currentValue, nextValue) ? currentValue : nextValue;

interface UseReaderChromeArgs {
  activeSectionId: string | null;
  sidebarGroups: SidebarGroup[];
}

interface MobileSidebarState {
  isOpen: boolean;
  sectionId: string | null;
}

// fallow-ignore-next-line unused-exports — used by useWorkspaceReaderState.ts
export const useReaderChrome = ({ activeSectionId, sidebarGroups }: UseReaderChromeArgs) => {
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [expandedModuleId, setExpandedModuleId] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches
  );
  const [mobileSidebarState, setMobileSidebarState] = useState<MobileSidebarState>({
    isOpen: false,
    sectionId: null,
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const previousActiveSectionIdRef = useRef<string | null>(null);
  const shouldUseDesktopSidebar = !isMobileViewport && !isFocusMode;
  const isMobileSidebarOpen =
    isMobileViewport &&
    mobileSidebarState.isOpen &&
    (activeSectionId === null || mobileSidebarState.sectionId === activeSectionId);
  const shouldShowSidebar = isMobileViewport ? isMobileSidebarOpen : !isFocusMode;

  const handleModuleToggle = useCallback((groupId: string) => {
    setExpandedModuleId(currentId => (currentId === groupId ? null : groupId));
  }, []);

  const setIsMobileSidebarOpen = useCallback(
    (nextValue: boolean | ((currentValue: boolean) => boolean)) => {
      setMobileSidebarState(currentState => {
        const currentValue =
          isMobileViewport &&
          currentState.isOpen &&
          (activeSectionId === null || currentState.sectionId === activeSectionId);
        const resolvedValue = typeof nextValue === 'function' ? nextValue(currentValue) : nextValue;

        if (currentState.isOpen === resolvedValue && currentState.sectionId === activeSectionId) {
          return currentState;
        }

        return {
          isOpen: resolvedValue,
          sectionId: activeSectionId,
        };
      });
    },
    [activeSectionId, isMobileViewport]
  );

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }

    const mediaQueryList = window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
    const handleMediaQueryChange = (event: MediaQueryListEvent) => {
      setIsMobileViewport(keepCurrentWhenEqual(event.matches));

      if (!event.matches) {
        setMobileSidebarState(currentState =>
          currentState.isOpen ? { ...currentState, isOpen: false } : currentState
        );
      }
    };

    return subscribeToMediaQuery(mediaQueryList, handleMediaQueryChange);
  }, []);

  useEffect(() => {
    const nextState: ExpandedModuleState = resolveExpandedModuleState({
      activeSectionId,
      currentExpandedModuleId: expandedModuleId,
      previousActiveSectionId: previousActiveSectionIdRef.current,
      sidebarGroups,
    });

    if (nextState.expandedModuleId !== expandedModuleId) {
      setExpandedModuleId(nextState.expandedModuleId);
    }

    if (nextState.previousActiveSectionId !== previousActiveSectionIdRef.current) {
      previousActiveSectionIdRef.current = nextState.previousActiveSectionId;
    }
  }, [activeSectionId, expandedModuleId, sidebarGroups]);

  return useMemo(
    () => ({
      expandedModuleId,
      handleModuleToggle,
      isDarkMode,
      isFocusMode,
      isMobileSidebarOpen,
      isMobileViewport,
      isSettingsOpen,
      setIsDarkMode,
      setIsFocusMode,
      setIsMobileSidebarOpen,
      setIsSettingsOpen,
      shouldShowSidebar,
      shouldUseDesktopSidebar,
    }),
    [
      expandedModuleId,
      handleModuleToggle,
      isDarkMode,
      isFocusMode,
      isMobileSidebarOpen,
      isMobileViewport,
      isSettingsOpen,
      shouldShowSidebar,
      shouldUseDesktopSidebar,
      setIsMobileSidebarOpen,
    ]
  );
};
