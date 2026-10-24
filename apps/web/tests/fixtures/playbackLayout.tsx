import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { createRoot } from 'react-dom/client';
import {
  resolvePlaybackNarration,
  segmentLessonPlayback,
} from '../../../../packages/shared-types/lessonPlayback';
import {
  FORMULA_SPOTLIGHT_MARKDOWN,
  formulaSpotlight,
} from '../../../backend/tests/helpers/formulaSpotlight';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';

import { renderPhoneVisualCards } from './playbackPhoneCards';

if (new URLSearchParams(location.search).has('case')) {
  renderPhoneVisualCards();
} else {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        'Il programma invoca open. La libreria prepara gli argomenti. Il kernel verifica i permessi e apre il file.',
    },
  ];
  const boundaryProof = new URLSearchParams(location.search).has('boundary');
  const snapshotProof = new URLSearchParams(location.search).has('snapshot');
  const formulaPath = new URLSearchParams(location.search).get('formulaPath');
  const formulaCount = Number(new URLSearchParams(location.search).get('formulas'));
  if (formulaCount)
    sources[0].markdown =
      formulaCount === 1
        ? String.raw`The result is $\mathbf h=\omega x+b$.`
        : 'Compare $a$, $b$ and $c$.';
  if (formulaPath === 'scene' || formulaPath === 'stored')
    sources[0].markdown = FORMULA_SPOTLIGHT_MARKDOWN;
  if (formulaPath === 'wide-scene')
    sources[0].markdown = `$${Array(4).fill(String.raw`p_\theta(y\mid x)`).join('+')}$`;
  if (formulaPath === 'cards') sources[0].markdown = 'Compare $a$, $b$ and $c$.';
  if (formulaPath === 'inherited')
    sources[0].markdown = '# Function\n\nThe result is $h=wx+b$.\n\nIts bias shifts the result.';
  if (formulaPath === 'inline') sources[0].markdown = 'The result is $h=wx+b$.';
  if (snapshotProof) sources[0].markdown = Array(50).fill(sources[0].markdown).join(' ');
  if (boundaryProof) sources[0].markdown += '\n\nIl file è pronto.';
  let scene: LessonScene = {
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
    diagram: {
      nodes: [
        { id: 'a', label: 'Programma', kind: 'start' },
        { id: 'b', label: 'Kernel', kind: 'end' },
      ],
      edges: [{ from: 'a', to: 'b', label: 'open', kind: 'call', evidence: sources[0].markdown }],
    },
    groups: [],
    note: '',
    quote: '',
  };
  scene.items.forEach((item, index) => {
    item.value = index + 1;
  });
  if (formulaCount === 3) {
    scene = {
      ...scene,
      type: 'parts',
      diagram: undefined,
      items: scene.items.slice(0, formulaCount),
    };
  }
  const blocks = segmentLessonPlayback(sources);
  document.documentElement.style.cssText =
    '--bg-paper:#fdfbf7;--bg-surface:#fff;--ink-primary:#1f1f1f;--ink-secondary:#4a4a4a;--border-subtle:#e5e7eb';
  const root = document.getElementById('root');
  if (!root) throw new Error('Fixture root must exist');
  const playbackRoot = createRoot(root);
  function renderBlock(index: number) {
    const source = blocks[index];
    const duration = 30;
    let block: LessonPlaybackBlock = {
      ...source,
      visuals: formulaCount ? source.visuals : [{ kind: 'scene', scene }],
      ...(formulaCount
        ? { prepared: { motion: [], ...(formulaCount === 3 ? { scene } : {}) } }
        : {}),
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
    if (formulaCount === 1 && formulaPath === 'aligned') {
      block = { ...block, visuals: [...source.visuals, { kind: 'scene', scene }] };
    }
    if (formulaCount === 1 && formulaPath === 'fallback') {
      block = { ...block, prepared: { scene, motion: [] } };
    }
    if (formulaPath === 'cards') {
      block = {
        ...block,
        visuals: source.spans.flatMap(span =>
          span.math ? [{ kind: 'markdown' as const, markdown: span.math }] : []
        ),
        prepared: {
          motion: [],
          spokenMath: source.spans.flatMap((span, index) =>
            span.math ? [{ formula: span.math, spoken: `Quantity ${index}` }] : []
          ),
        },
      };
    }
    if (formulaPath === 'inline') {
      block = { ...block, visuals: [{ kind: 'markdown', markdown: '$h=wx+b$' }] };
    }
    if (formulaPath === 'scene') {
      block = { ...block, prepared: { scene: formulaSpotlight, motion: [] } };
    }
    if (formulaPath === 'wide-scene') {
      block = {
        ...block,
        prepared: {
          scene: {
            ...formulaSpotlight,
            formula: Array(4).fill(formulaSpotlight.formula).join('+'),
          },
          motion: [],
        },
      };
    }
    if (formulaPath === 'stored') {
      block = { ...block, visuals: [{ kind: 'generated-visual', visualId: 'stored-formula' }] };
    }
    const content: Partial<WorkspaceReaderContentModel> = {
      ...(new URLSearchParams(location.search).has('saveVisual')
        ? {
            projectId: 'synthetic-course',
            activeSectionId: 'synthetic-lesson',
            onSavePlaybackVisual: async () => ({ succeeded: true }),
            onRemovePlaybackVisual: async () => ({ succeeded: true }),
          }
        : {}),
      isDarkMode: false,
      sectionContentBlocks: structuredClone(sources),
      activeSectionGeneratedVisualsById: {
        'stored-formula': {
          id: 'stored-formula',
          title: formulaSpotlight.title,
          kind: 'scene',
          scene: formulaSpotlight,
          code: '',
          createdAt: '',
        },
      },
    };
    const alignedWords = resolvePlaybackNarration(block).speech.trim().split(/\s+/u);
    playbackRoot.render(
      <div style={{ height: '100dvh', display: 'flex' }}>
        <LessonPlaybackStage
          lessonKey="synthetic-version"
          block={structuredClone(block)}
          content={content as WorkspaceReaderContentModel}
          alignment={
            formulaPath === 'cards'
              ? {
                  status: 'aligned',
                  onsets: alignedWords.map((_, index) => (duration * index) / alignedWords.length),
                }
              : undefined
          }
          duration={duration}
          time={formulaPath === 'cards' ? 0 : duration / 2}
        />
      </div>
    );
  }
  renderBlock(formulaPath === 'inherited' ? 1 : 0);
  if (boundaryProof) {
    let index = 0;
    addEventListener('playback-next', () => {
      index = (index + 1) % blocks.length;
      renderBlock(index);
    });
  }

  if (snapshotProof) {
    addEventListener('playback-snapshot', () => renderBlock(0));
    addEventListener('playback-scene-change', () => {
      scene = { ...scene, title: 'Nuovo contenuto' };
      if (scene.diagram) scene.diagram.nodes[0].label = 'Nuovo programma';
      scene.items[0].value = 10;
      renderBlock(0);
    });
  }
}
