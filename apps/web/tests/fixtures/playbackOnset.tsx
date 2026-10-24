import { segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { guidedPathScene } from '../../../backend/tests/helpers/animatedLessonScenes';
import { formulaSpotlight } from '../../../backend/tests/helpers/formulaSpotlight';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';

const mode = new URLSearchParams(location.search).get('mode');
const wideFormula = `$\\frac{${Array.from({ length: 24 }, (_, index) => `x_{${index + 1}}`).join('+')}}{y}$`;
// Monospace words give each synthetic recording an exact, uniform word clock.
const sources = [
  {
    type: 'markdown' as const,
    markdown:
      mode === 'wide-formula'
        ? `Uno ${wideFormula} Uno`
        : mode === 'cards'
          ? 'Uno $a$ $b$ Uno Uno Uno Uno Uno $a$ Uno'
          : 'Uno Due Tre',
  },
];
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
  mode === 'wide-formula'
    ? { motion: [], spokenMath: [{ formula: wideFormula, spoken: 'Due' }] }
    : mode === 'cards'
      ? {
          motion: [],
          spokenMath: [
            { formula: '$a$', spoken: 'Due' },
            { formula: '$b$', spoken: 'Tre' },
            { formula: '$a$', spoken: 'Due' },
          ],
        }
      : mode === 'fallback'
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
        block={{
          ...block,
          prepared,
          ...(mode === 'cards'
            ? {
                visuals: ['$a$', '$b$', '$a$'].map(markdown => ({
                  kind: 'markdown' as const,
                  markdown,
                })),
              }
            : {}),
        }}
        content={content}
        duration={mode === 'cards' ? 10 : 6}
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
