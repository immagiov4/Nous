import { useLayoutEffect } from 'react';
import { READER_SIDEBAR_WIDTH_PX } from '../../constants/layout.ts';
import AudioPlayer from './AudioPlayer.tsx';
import type { WorkspaceReaderShellProps } from './shell/types.ts';
import WorkspaceReaderBanners from './shell/WorkspaceReaderBanners.tsx';
import WorkspaceReaderContent from './shell/WorkspaceReaderContent.tsx';
import WorkspaceReaderHeader from './shell/WorkspaceReaderHeader.tsx';
import WorkspaceReaderOverlays from './shell/WorkspaceReaderOverlays.tsx';
import WorkspaceReaderSidebar from './shell/WorkspaceReaderSidebar.tsx';

export default function WorkspaceReaderShell({
  audioPlayer,
  banners,
  content,
  header,
  overlays,
  shouldUseDesktopSidebar,
  sidebar,
}: WorkspaceReaderShellProps) {
  useLayoutEffect(() => {
    if (typeof document === 'undefined') {
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
  }, []);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const resetScrollPosition = () => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      content.scrollContainerRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    };

    resetScrollPosition();
    const frameId = window.requestAnimationFrame(resetScrollPosition);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [content.scrollContainerRef]);

  return (
    <div
      className="flex h-screen max-w-full overflow-hidden overscroll-none bg-paper-light font-sans transition-colors duration-300 dark:bg-paper-dark"
      style={{ height: '100dvh', maxHeight: '100dvh' }}
    >
      <WorkspaceReaderSidebar {...sidebar} />

      <div
        className="relative flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-hidden bg-paper-light transition-[margin] duration-300 dark:bg-paper-dark"
        style={{ marginLeft: shouldUseDesktopSidebar ? READER_SIDEBAR_WIDTH_PX : 0 }}
      >
        <WorkspaceReaderBanners {...banners} />
        <WorkspaceReaderHeader {...header} />
        <WorkspaceReaderContent {...content} />

        {audioPlayer.sectionContent && audioPlayer.ttsConnected ? (
          <AudioPlayer
            availableVoices={audioPlayer.availableVoices}
            isPlaying={audioPlayer.audioState.isPlaying}
            isLoading={audioPlayer.playerCurrentChunkIsLoading}
            currentVoice={audioPlayer.audioState.currentVoice}
            playbackRate={audioPlayer.audioState.playbackRate}
            isVertical
            dockOffsetPx={audioPlayer.audioDockOffset}
            currentTime={audioPlayer.currentTime}
            duration={audioPlayer.duration}
            onPlayPause={audioPlayer.onPlayPause}
            onVoiceChange={audioPlayer.onVoiceChange}
            onSpeedChange={audioPlayer.onSpeedChange}
            onSeek={audioPlayer.onSeek}
            onSkipChunk={audioPlayer.onSkipChunk}
            ttsConnected={audioPlayer.ttsConnected}
          />
        ) : null}

        <WorkspaceReaderOverlays {...overlays} />
      </div>
    </div>
  );
}
