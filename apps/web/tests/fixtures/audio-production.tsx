import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';
import { PlaybackTimeline } from '../../components/workspace/UnifiedAudioPanel';
import { useLessonPlayback } from '../../hooks/reader/useLessonPlayback';
import '../../styles/app.css';

const markdown = new URLSearchParams(location.search).get('speech') ?? 'Fixed audio sample.';
const sources = [{ type: 'markdown' as const, markdown }];
const initialBlocks = segmentLessonPlayback(sources);
const isDarkMode = matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', isDarkMode);

function AudioContract() {
  const [voice, setVoice] = useState('Kore');
  const [speed, setSpeed] = useState(1);
  const playback = useLessonPlayback({
    projectId: 'audio-contract',
    sectionId: 'lesson',
    voice,
    speed,
    initialBlocks,
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <header>
        <button type="button" id="play" onClick={() => void playback.play()}>
          {playback.failed ? 'Retry' : 'Play'}
        </button>
        <button type="button" id="pause" onClick={playback.pause}>
          Pause
        </button>
        <button type="button" id="seek" onClick={() => playback.seek(0)}>
          Seek
        </button>
        <PlaybackTimeline
          time={playback.elapsed}
          duration={playback.total}
          onSeek={playback.seek}
        />
        <button
          type="button"
          id="voice"
          onClick={() => setVoice(current => (current === 'Kore' ? 'Puck' : 'Kore'))}
        >
          Voice
        </button>
        <button
          type="button"
          id="speed"
          onClick={() => setSpeed(current => (current === 1 ? 2 : 1))}
        >
          Speed
        </button>
        <output data-position={playback.time} data-duration={playback.duration}>
          {playback.loading
            ? 'loading'
            : playback.failed
              ? 'failed'
              : playback.playing
                ? 'playing'
                : 'idle'}
        </output>
      </header>
      <LessonPlaybackStage
        block={playback.blocks[playback.index]}
        content={
          {
            isDarkMode,
            sectionContentBlocks: sources,
          } as WorkspaceReaderContentModel
        }
        time={playback.time}
        duration={playback.duration}
        readTime={playback.readTime}
        seekRevision={playback.seekRevision}
        loading={playback.loading}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Audio contract root missing');
createRoot(root).render(<AudioContract />);
