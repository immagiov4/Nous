import { memo, useEffect, useLayoutEffect } from 'react';
import {
  READER_MOBILE_TOP_FADE_ALPHA_PROPERTY,
  READER_MOBILE_TOP_FADE_SCROLL_RANGE_PX,
  READER_SIDEBAR_WIDTH_PX,
} from '../../constants/layout.ts';
import { useMobileKeyboardOffset } from '../../hooks/useMobileKeyboardOffset.ts';
import type { WorkspaceReaderShellProps } from './shell/types.ts';
import WorkspaceReaderBanners from './shell/WorkspaceReaderBanners.tsx';
import WorkspaceReaderContent from './shell/WorkspaceReaderContent.tsx';
import WorkspaceReaderHeader from './shell/WorkspaceReaderHeader.tsx';
import WorkspaceReaderOverlays from './shell/WorkspaceReaderOverlays.tsx';
import WorkspaceReaderSidebar from './shell/WorkspaceReaderSidebar.tsx';

const WorkspaceReaderShell = memo(function WorkspaceReaderShell({
  banners,
  content,
  displayMode = 'application',
  header,
  overlays,
  shouldUseDesktopSidebar,
  sidebar,
}: WorkspaceReaderShellProps) {
  const { viewportHeight } = useMobileKeyboardOffset();

  useEffect(() => {
    if (displayMode === 'embedded' || !header.isMobileViewport) {
      return;
    }

    const scrollContainer = content.scrollContainerRef.current;
    if (!scrollContainer) {
      return;
    }

    let previousFadeAlpha = '';
    const handleScroll = () => {
      const fadeProgress = Math.min(
        scrollContainer.scrollTop / READER_MOBILE_TOP_FADE_SCROLL_RANGE_PX,
        1
      );
      const fadeAlpha = (1 - fadeProgress).toFixed(3);
      if (fadeAlpha === previousFadeAlpha) {
        return;
      }

      previousFadeAlpha = fadeAlpha;
      scrollContainer.style.setProperty(READER_MOBILE_TOP_FADE_ALPHA_PROPERTY, fadeAlpha);
    };

    handleScroll();
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      scrollContainer.style.removeProperty(READER_MOBILE_TOP_FADE_ALPHA_PROPERTY);
    };
  }, [content.scrollContainerRef, displayMode, header.isMobileViewport]);

  useLayoutEffect(() => {
    if (displayMode === 'embedded' || typeof document === 'undefined') {
      return;
    }

    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousHtmlOverscroll = html.style.overscrollBehavior;
    const previousBodyOverscroll = body.style.overscrollBehavior;

    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'none';
    body.style.overscrollBehavior = 'none';

    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
      html.style.overscrollBehavior = previousHtmlOverscroll;
      body.style.overscrollBehavior = previousBodyOverscroll;
    };
  }, [displayMode]);

  useLayoutEffect(() => {
    if (displayMode === 'embedded' || typeof globalThis.window === 'undefined') {
      return;
    }

    const resetScrollPosition = () => {
      globalThis.window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      content.scrollContainerRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    };

    // The reader swaps from document scrolling to an internal scroll container; resetting once now
    // and once after layout prevents the previous screen position from leaking into the lesson view.
    resetScrollPosition();
    const frameId = globalThis.window.requestAnimationFrame(resetScrollPosition);

    return () => {
      globalThis.window.cancelAnimationFrame(frameId);
    };
  }, [content.scrollContainerRef, displayMode]);

  const isEmbedded = displayMode === 'embedded';
  const sidebarModel = isEmbedded ? { ...sidebar, placement: 'container' as const } : sidebar;
  const contentModel = isEmbedded ? { ...content, scrollMode: 'document' as const } : content;

  return (
    <div
      data-reader-display-mode={displayMode}
      className={`relative flex max-w-full overscroll-none bg-paper-light font-sans transition-colors duration-300 dark:bg-paper-dark ${
        isEmbedded
          ? `${header.isDarkMode ? 'dark ' : ''}min-h-[34rem] overflow-visible`
          : 'h-screen overflow-hidden'
      }`}
      style={
        isEmbedded
          ? undefined
          : {
              height: viewportHeight === null ? '100dvh' : `${viewportHeight}px`,
              maxHeight: viewportHeight === null ? '100dvh' : `${viewportHeight}px`,
            }
      }
    >
      {!header.isMobileViewport ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-white/80 backdrop-blur dark:bg-zinc-800/80"
        />
      ) : null}
      <WorkspaceReaderSidebar {...sidebarModel} />

      <div
        className="relative flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-hidden bg-paper-light transition-[margin] duration-300 dark:bg-paper-dark"
        style={{ marginLeft: shouldUseDesktopSidebar ? READER_SIDEBAR_WIDTH_PX : 0 }}
      >
        <WorkspaceReaderBanners {...banners} />
        <WorkspaceReaderHeader {...header} />
        <div
          data-reader-content-layer="true"
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <WorkspaceReaderContent {...contentModel} />
          <WorkspaceReaderOverlays {...overlays} />
        </div>
      </div>
    </div>
  );
});

export default WorkspaceReaderShell;
