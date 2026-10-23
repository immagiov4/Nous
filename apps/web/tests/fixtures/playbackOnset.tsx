import { segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { guidedPathScene } from '../../../backend/tests/helpers/animatedLessonScenes';
import { formulaSpotlight } from '../../../backend/tests/helpers/formulaSpotlight';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';

// Equal-width words give this synthetic recording exact starts at 0, 2 and 4 seconds.
const sources = [{ type: 'markdown' as const, markdown: 'Uno Due Tre' }];
const block = segmentLessonPlayback(sources)[0];
const scene: LessonScene = {
  type: 'parts',
  title: 'Segnali',
  body: '',
  groups: [],
  quote: '',
  note: '',
  items: [
    { icon: 'point', label: 'Comparsa', detail: '' },
    { icon: 'point', label: 'Evidenza', detail: '' },
  ],
};
const content = { isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel;
let time = 0;
const host = document.getElementById('root');
if (!host) throw new Error('Fixture root must exist');
const root = createRoot(host);
const mode = new URLSearchParams(location.search).get('mode');
const displayedScene =
  mode === 'path'
    ? {
        ...guidedPathScene,
        narration: undefined,
        steps: [
          { label: 'Prima', detail: 'Primo passo', anchor: 'Uno' },
          { label: 'Seconda', detail: 'Secondo passo', anchor: 'Due' },
        ],
      }
    : mode === 'formula'
      ? {
          ...formulaSpotlight,
          formula: String.raw`\nousSymbol{probability}`,
          symbols: [{ ...formulaSpotlight.symbols[0], anchor: 'Due' }],
        }
      : scene;
const prepared =
  mode === 'fallback'
    ? undefined
    : {
        scene: displayedScene,
        motion:
          mode === 'path' || mode === 'formula'
            ? []
            : [
                { effect: 'reveal' as const, targets: ['item:0'], quote: 'Due' },
                { effect: 'focus' as const, targets: ['item:1'], quote: 'Due' },
              ],
      };
const style = document.createElement('style');
style.textContent =
  '.caption-word { font-family: monospace !important; font-weight: normal !important; }';
document.head.append(style);
flushSync(() =>
  root.render(
    <div style={{ height: '100dvh', display: 'flex' }}>
      <LessonPlaybackStage
        block={{ ...block, prepared }}
        content={content}
        duration={6}
        time={0}
        readTime={() => time}
      />
    </div>
  )
);
Object.assign(window, {
  setPlaybackTime: (next: number) => {
    time = next;
  },
});
