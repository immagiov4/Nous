import { useLayoutEffect } from 'react';
import AudioPlayer from './AudioPlayer.tsx';
import WorkspaceReaderBanners from './shell/WorkspaceReaderBanners.tsx';
import WorkspaceReaderContent from './shell/WorkspaceReaderContent.tsx';
import WorkspaceReaderHeader from './shell/WorkspaceReaderHeader.tsx';
import WorkspaceReaderOverlays from './shell/WorkspaceReaderOverlays.tsx';
import WorkspaceReaderSidebar from './shell/WorkspaceReaderSidebar.tsx';
import type { WorkspaceReaderShellProps } from './shell/types.ts';

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
    <div className="flex h-screen max-w-full overflow-hidden bg-paper-light font-sans transition-colors duration-300 dark:bg-paper-dark">
      <WorkspaceReaderSidebar {...sidebar} />

      <div
        className="relative flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-hidden bg-paper-light transition-[margin] duration-300 dark:bg-paper-dark"
        style={{ marginLeft: shouldUseDesktopSidebar ? 384 : 0 }}
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
