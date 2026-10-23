import { segmentLessonPlayback } from '@shared/lessonPlayback';
import fontUrl from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?url';
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';

const sources = [
  {
    type: 'markdown' as const,
    markdown: Array.from(
      { length: 12 },
      () =>
        'La **memoria** conserva i dati del programma mentre il processore legge le istruzioni e aggiorna il risultato con `open`.'
    ).join(' '),
  },
];
const block = {
  ...segmentLessonPlayback(sources)[0],
  visuals: [
    {
      kind: 'markdown' as const,
      markdown: '## Memoria e processore\n\nI dati accompagnano le istruzioni.',
    },
  ],
};
const content = { isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel;
function Fixture() {
  const [time, setTime] = useState(0);
  const [passage, setPassage] = useState(0);
  const currentBlock = useMemo(() => ({ ...block, id: String(passage) }), [passage]);
  return (
    <>
      <style>{`@font-face { font-family: "Caption fixture"; src: url("${fontUrl}"); font-display: swap; } .lesson-player-stage { font-family: "Caption fixture", sans-serif; }`}</style>
      <div style={{ height: '100dvh', display: 'flex' }}>
        <LessonPlaybackStage block={currentBlock} content={content} duration={60} time={time} />
      </div>
      <div style={{ position: 'fixed', bottom: 0, right: 0 }}>
        <input
          aria-label="Playback time"
          type="number"
          value={time}
          onChange={event => setTime(Number(event.target.value))}
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
      </div>
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root must exist');
createRoot(root).render(<Fixture />);
