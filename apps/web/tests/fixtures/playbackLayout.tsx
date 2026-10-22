import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { createRoot } from 'react-dom/client';
import { segmentLessonPlayback } from '../../../../packages/shared-types/lessonPlayback';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';

const sources = [
  {
    type: 'markdown' as const,
    markdown:
      'Il programma invoca open. La libreria prepara gli argomenti. Il kernel verifica i permessi e apre il file.',
  },
];
const boundaryProof = new URLSearchParams(location.search).has('boundary');
if (boundaryProof) sources[0].markdown += '\n\nIl file è pronto.';
const scene: LessonScene = {
  type: (new URLSearchParams(location.search).get('type') || 'causal') as LessonScene['type'],
  title: 'Il percorso da open() alla system call',
  body: '',
  items: [
    {
      icon: 'point',
      label: 'Sorgente C',
      detail:
        'Il programma chiama open indicando il percorso del file e le modalità di accesso richieste.',
    },
    {
      icon: 'point',
      label: 'Libreria C',
      detail:
        'La funzione della libreria prepara gli argomenti e traduce la chiamata nel servizio del sistema operativo.',
    },
    {
      icon: 'point',
      label: 'ABI del kernel',
      detail:
        'Il numero della chiamata e gli argomenti vengono inseriti nei registri previsti dal contratto binario.',
    },
    {
      icon: 'point',
      label: 'Kernel Linux',
      detail:
        'Il kernel verifica i permessi, apre il file e restituisce un descrittore oppure un errore al programma.',
    },
  ],
  groups: [],
  note: '',
  quote: '',
};
const blocks = segmentLessonPlayback(sources);
document.documentElement.style.cssText =
  '--bg-paper:#fdfbf7;--bg-surface:#fff;--ink-primary:#1f1f1f;--ink-secondary:#4a4a4a;--border-subtle:#e5e7eb';
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root must exist');
const playbackRoot = createRoot(root);
function renderBlock(index: number) {
  const source = blocks[index];
  const block: LessonPlaybackBlock = {
    ...source,
    visuals: [{ kind: 'scene', scene }],
    ...(boundaryProof
      ? {
          prepared: {
            scene,
            motion: [
              {
                effect: 'focus',
                targets: ['item:0'],
                quote: source.speech.slice(source.speech.lastIndexOf(' ') + 1),
              },
            ],
          },
        }
      : {}),
  };
  playbackRoot.render(
    <div style={{ height: '100dvh', display: 'flex' }}>
      <LessonPlaybackStage
        block={block}
        content={
          { isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel
        }
        duration={30}
        time={15}
      />
    </div>
  );
}
renderBlock(0);
if (boundaryProof) {
  let index = 0;
  addEventListener('playback-next', () => {
    index = (index + 1) % blocks.length;
    renderBlock(index);
  });
}
