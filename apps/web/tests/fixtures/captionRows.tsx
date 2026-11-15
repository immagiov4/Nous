import { resolvePlaybackNarration, segmentLessonPlayback } from '@shared/lessonPlayback';
import { narrationWords, type PlaybackWordAlignment } from '@shared/playbackWordTiming';
import fontUrl from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?url';
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';
import '../../styles/app.css';

const acousticFollow = new URLSearchParams(location.search).has('follow');
const sources = [
  {
    type: 'markdown' as const,
    markdown: Array.from({ length: 12 }, () =>
      acousticFollow
        ? 'Sincronizzazione rappresentazione elaborazione memorizzazione organizzazione comprensione.'
        : 'La **memoria** conserva i dati del programma mentre il processore legge le istruzioni e aggiorna il risultato con `open`.'
    ).join(' '),
  },
];
const block = {
  ...segmentLessonPlayback(sources)[0],
  ...(new URLSearchParams(location.search).has('mobile')
    ? {
        prepared: {
          motion: [],
          scene: {
            type: 'parts' as const,
            title: 'Memoria e processore',
            body: '',
            groups: [],
            quote: '',
            note: '',
            items: [{ icon: 'point', label: 'Memoria', detail: 'Conserva i dati.' }],
          },
        },
      }
    : {}),
  visuals: [
    {
      kind: 'markdown' as const,
      markdown: '## Memoria e processore\n\nI dati accompagnano le istruzioni.',
    },
  ],
};
const content = { isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel;
const durationSeconds = acousticFollow ? 18 : 60;
function Fixture() {
  const [dark, setDark] = useState(false);
  const [alignment, setAlignment] = useState<PlaybackWordAlignment | undefined>(
    acousticFollow
      ? {
          status: 'aligned',
          onsets: narrationWords(resolvePlaybackNarration(block).speech).map(
            (_, index) => index / 4
          ),
        }
      : undefined
  );
  const [time, setTime] = useState(0);
  const [seekRevision, setSeekRevision] = useState(0);
  useEffect(() => {
    const advance = (event: Event) => setTime((event as CustomEvent<number>).detail);
    window.addEventListener('caption-playback-time', advance);
    return () => window.removeEventListener('caption-playback-time', advance);
  }, []);
  const [passage, setPassage] = useState(0);
  const currentBlock = useMemo(() => ({ ...block, id: String(passage) }), [passage]);
  return (
    <>
      <style>{`@font-face { font-family: "Caption fixture"; src: url("${fontUrl}"); font-display: swap; } .lesson-player-stage { font-family: "Caption fixture", sans-serif; }`}</style>
      <div className={dark ? 'dark' : ''} style={{ height: '100dvh', display: 'flex' }}>
        <LessonPlaybackStage
          block={currentBlock}
          content={{ ...content, isDarkMode: dark }}
          duration={durationSeconds}
          time={time}
          seekRevision={seekRevision}
          alignment={alignment}
        />
      </div>
      <div style={{ position: 'fixed', bottom: 0, right: 0 }}>
        <button type="button" onClick={() => setDark(!dark)}>
          Switch theme
        </button>
        <button
          type="button"
          onClick={() => {
            const words = narrationWords(resolvePlaybackNarration(currentBlock).speech);
            setAlignment({
              status: 'aligned',
              onsets: words.map((_, index) => (durationSeconds * index) / words.length),
            });
          }}
        >
          Refresh recording timing
        </button>
        <input
          aria-label="Playback time"
          type="number"
          value={time}
          onChange={event => {
            setTime(Number(event.target.value));
            setSeekRevision(revision => revision + 1);
          }}
        />
        <button
          type="button"
          onClick={() => {
            setPassage(passage + 1);
            setTime(0);
          }}
        >
          Next passage
        </button>
        <button
          type="button"
          onClick={() => {
            setPassage(passage - 1);
            setTime(18);
          }}
        >
          Previous passage midpoint
        </button>
      </div>
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root must exist');
createRoot(root).render(<Fixture />);
