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
const block: LessonPlaybackBlock = {
  ...segmentLessonPlayback(sources)[0],
  visuals: [{ kind: 'scene', scene }],
};
document.documentElement.style.cssText =
  '--bg-paper:#fdfbf7;--bg-surface:#fff;--ink-primary:#1f1f1f;--ink-secondary:#4a4a4a;--border-subtle:#e5e7eb';
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root must exist');
createRoot(root).render(
  <div style={{ height: '100dvh', display: 'flex' }}>
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={30}
      time={15}
    />
  </div>
);
