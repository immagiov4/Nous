import AudioPlayer from './AudioPlayer.tsx';
import ReadingRuler from './ReadingRuler.tsx';
import WorkspaceReaderBanners from './workspace-reader-shell/WorkspaceReaderBanners.tsx';
import WorkspaceReaderContent from './workspace-reader-shell/WorkspaceReaderContent.tsx';
import WorkspaceReaderHeader from './workspace-reader-shell/WorkspaceReaderHeader.tsx';
import WorkspaceReaderOverlays from './workspace-reader-shell/WorkspaceReaderOverlays.tsx';
import WorkspaceReaderSidebar from './workspace-reader-shell/WorkspaceReaderSidebar.tsx';
import type { WorkspaceReaderShellProps } from './workspace-reader-shell/types.ts';

export default function WorkspaceReaderShell({
  audioPlayer,
  banners,
  content,
  header,
  overlays,
  ruler,
  shouldUseDesktopSidebar,
  sidebar,
}: WorkspaceReaderShellProps) {
  return (
    <div className="flex h-screen max-w-full overflow-hidden bg-paper-light font-sans transition-colors duration-300 dark:bg-paper-dark">
      {ruler.isRulerActive ? (
        <ReadingRuler
          isPlaying={ruler.isPlaying}
          progress={ruler.visualProgress}
          contentRef={ruler.contentRef}
          scrollContainerRef={ruler.scrollContainerRef}
          calibrationOffset={ruler.calibrationOffset}
          teleprompterSpeed={ruler.teleprompterSpeed}
          isHeaderHovered={ruler.isHeaderHovered}
        />
      ) : null}

      <WorkspaceReaderSidebar {...sidebar} />

      <div
        className="relative flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-hidden bg-paper-light transition-[margin] duration-300 dark:bg-paper-dark"
        style={{ marginLeft: shouldUseDesktopSidebar ? 384 : 0 }}
      >
        <WorkspaceReaderBanners {...banners} />
        <WorkspaceReaderHeader {...header} />
        <WorkspaceReaderContent {...content} />

        {audioPlayer.sectionContent ? (
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
            isAudioSyncLinked={audioPlayer.isAudioSyncLinked}
            onToggleAudioSyncLink={audioPlayer.onToggleAudioSyncLink}
            ttsConnected={audioPlayer.ttsConnected}
          />
        ) : null}

        <WorkspaceReaderOverlays {...overlays} />
      </div>
    </div>
  );
}
