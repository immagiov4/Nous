/* @refresh reset */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  READER_MOBILE_LAYOUT_BREAKPOINT_PX,
  READER_SIDEBAR_WIDTH_PX,
} from '../../constants/layout.ts';
import { subscribeToMediaQuery } from '../../utils/dom/mediaQuery.ts';
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

export const useReaderChrome = ({ activeSectionId, sidebarGroups }: UseReaderChromeArgs) => {
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [expandedModuleId, setExpandedModuleId] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches
  );
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const previousActiveSectionIdRef = useRef<string | null>(null);
  const shouldUseDesktopSidebar = !isMobileViewport && !isFocusMode;
  const shouldShowSidebar = isMobileViewport ? isMobileSidebarOpen : !isFocusMode;
  const audioDockOffset = shouldUseDesktopSidebar ? READER_SIDEBAR_WIDTH_PX : 0;

  const handleModuleToggle = useCallback((groupId: string) => {
    setExpandedModuleId(currentId => (currentId === groupId ? null : groupId));
  }, []);

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
    };

    setIsMobileViewport(keepCurrentWhenEqual(mediaQueryList.matches));
    return subscribeToMediaQuery(mediaQueryList, handleMediaQueryChange);
  }, []);

  useEffect(() => {
    if (!isMobileViewport) {
      setIsMobileSidebarOpen(keepCurrentWhenEqual(false));
    }
  }, [isMobileViewport]);

  useEffect(() => {
    if (isMobileViewport && activeSectionId) {
      setIsMobileSidebarOpen(keepCurrentWhenEqual(false));
    }
  }, [activeSectionId, isMobileViewport]);

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
      audioDockOffset,
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
      audioDockOffset,
      expandedModuleId,
      handleModuleToggle,
      isDarkMode,
      isFocusMode,
      isMobileSidebarOpen,
      isMobileViewport,
      isSettingsOpen,
      shouldShowSidebar,
      shouldUseDesktopSidebar,
    ]
  );
};
