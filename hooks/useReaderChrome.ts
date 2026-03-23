/* @refresh reset */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveExpandedModuleState, type ExpandedModuleState } from '../utils/readerChrome.ts';
import type { SidebarGroup } from '../utils/workspaceReader.ts';

const SIDEBAR_WIDTH_PX = 384;
const MOBILE_LAYOUT_BREAKPOINT_PX = 1024;
const MOBILE_LAYOUT_MEDIA_QUERY = `(max-width: ${MOBILE_LAYOUT_BREAKPOINT_PX - 1}px)`;

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
  const audioDockOffset = shouldUseDesktopSidebar ? SIDEBAR_WIDTH_PX : 0;

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
    const mediaQueryList = window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
    const handleMediaQueryChange = (event: MediaQueryListEvent) => {
      setIsMobileViewport(event.matches);
    };

    setIsMobileViewport(mediaQueryList.matches);
    mediaQueryList.addEventListener('change', handleMediaQueryChange);
    return () => {
      mediaQueryList.removeEventListener('change', handleMediaQueryChange);
    };
  }, []);

  useEffect(() => {
    if (!isMobileViewport) {
      setIsMobileSidebarOpen(false);
    }
  }, [isMobileViewport]);

  useEffect(() => {
    if (isMobileViewport && activeSectionId) {
      setIsMobileSidebarOpen(false);
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
