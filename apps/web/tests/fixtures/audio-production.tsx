import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useLessonPlayback } from '../../hooks/reader/useLessonPlayback';

function AudioContract() {
  const [voice, setVoice] = useState('Kore');
  const [speed, setSpeed] = useState(1);
  const playback = useLessonPlayback({
    projectId: 'audio-contract',
    sectionId: 'lesson',
    voice,
    speed,
    initialBlocks: segmentLessonPlayback([{ type: 'markdown', markdown: 'Fixed audio sample.' }]),
  });
  return (
    <>
      <button type="button" id="play" onClick={() => void playback.play()}>
        {playback.failed ? 'Retry' : 'Play'}
      </button>
      <button type="button" id="pause" onClick={playback.pause}>
        Pause
      </button>
      <button type="button" id="seek" onClick={() => playback.seek(0)}>
        Seek
      </button>
      <button
        type="button"
        id="voice"
        onClick={() => setVoice(current => (current === 'Kore' ? 'Puck' : 'Kore'))}
      >
        Voice
      </button>
      <button type="button" id="speed" onClick={() => setSpeed(current => (current === 1 ? 2 : 1))}>
        Speed
      </button>
      <output data-position={playback.time}>
        {playback.loading
          ? 'loading'
          : playback.failed
            ? 'failed'
            : playback.playing
              ? 'playing'
              : 'idle'}
      </output>
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Audio contract root missing');
createRoot(root).render(<AudioContract />);
