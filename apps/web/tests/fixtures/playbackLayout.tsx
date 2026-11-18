import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { createRoot } from 'react-dom/client';
import playbackImageUrl from '../../../../packages/playtest/tests/fixtures/images/reference.jpg?url';
import {
  resolvePlaybackNarration,
  segmentLessonPlayback,
} from '../../../../packages/shared-types/lessonPlayback';
import {
  FORMULA_SPOTLIGHT_MARKDOWN,
  formulaSpotlight,
} from '../../../backend/tests/helpers/formulaSpotlight';
import { LessonSceneVisual } from '../../components/shared/lessonScene/LessonSceneVisual';
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
  const arithmetic = formulaPath === 'arithmetic';
  const arithmeticSymbols = [
    ['4', 'Four', 'is the first factor'],
    [String.raw`\times`, 'Times', 'means multiply'],
    ['3', 'Three', 'is the second factor'],
    ['=', 'Equals', 'introduces the result'],
    ['12', 'Twelve', 'is the product'],
  ].map(([latex, name, meaning], index) => ({
    id: `term${index}`,
    latex,
    name,
    meaning,
    anchor: name,
  }));
  const mixedImage = formulaPath === 'image';
  const imageAspect = new URLSearchParams(location.search).get('imageAspect');
  let mixedImageUrl = playbackImageUrl;
  if (imageAspect) {
    const canvas = document.createElement('canvas');
    canvas.width = imageAspect === 'wide' ? 2400 : 240;
    canvas.height = imageAspect === 'tall' ? 2400 : 240;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Synthetic image requires a canvas');
    context.fillStyle = '#dbeafe';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#1e40af';
    context.lineWidth = 12;
    context.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
    context.fillStyle = '#1e40af';
    context.font = '32px sans-serif';
    context.fillText('IMAGE', 24, 60);
    context.fillText('END', canvas.width - 96, canvas.height - 24);
    mixedImageUrl = canvas.toDataURL('image/png');
  }
  const isDarkMode = new URLSearchParams(location.search).has('dark');
  document.documentElement.classList.toggle('dark', isDarkMode);
  const formulaCount = Number(new URLSearchParams(location.search).get('formulas'));
  if (formulaCount)
    sources[0].markdown =
      formulaCount === 1
        ? String.raw`The result is $\mathbf h=\omega x+b$.`
        : 'Compare $a$, $b$ and $c$.';
  if (formulaPath === 'scene' || formulaPath === 'stored')
    sources[0].markdown = FORMULA_SPOTLIGHT_MARKDOWN;
  if (arithmetic)
    sources[0].markdown = arithmeticSymbols
      .map(({ name, meaning }) => `${name} ${meaning}.`)
      .join(' ');
  if (formulaPath === 'wide-scene')
    sources[0].markdown = `$${Array(4).fill(String.raw`p_\theta(y\mid x)`).join('+')}$`;
  if (formulaPath === 'cards') sources[0].markdown = 'Compare $a$, $b$ and $c$.';
  if (formulaPath === 'inherited')
    sources[0].markdown = '# Function\n\nThe result is $h=wx+b$.\n\nIts bias shifts the result.';
  if (formulaPath === 'inline') sources[0].markdown = 'The result is $h=wx+b$.';
  if (mixedImage)
    sources[0].markdown =
      'Compare $a$, $b$, $c$, $d$ and $e$.\n\n{{PDF_IMAGE:fixture-image|alt=Synthetic image}}';
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
  const conceptExample = new URLSearchParams(location.search).get('concept-example');
  if (conceptExample) {
    scene = { ...scene, type: 'concepts', diagram: undefined };
    const items = (entries: readonly [string, string, string][]) =>
      entries.map(([label, detail, icon]) => ({ label, detail, icon }));
    switch (conceptExample) {
      case 'grid':
        scene = {
          ...scene,
          title: 'Weather station instruments',
          conceptLayout: 'grid',
          items: items([
            ['Thermometer', 'Air temperature', 'temperature'],
            ['Rain gauge', 'Rainfall collected', 'droplet'],
            ['Wind vane', 'Wind direction', 'wind'],
          ]),
        };
        break;
      case 'roles':
        scene = {
          ...scene,
          title: 'Who runs the field survey?',
          conceptLayout: 'roles',
          items: items([
            ['Observer', 'Identifies birds by sight and sound', 'binoculars'],
            ['Recorder', 'Logs species and observation times', 'notebook'],
            ['Coordinator', 'Assigns routes to each group', 'map'],
          ]),
        };
        break;
      case 'featured':
        scene = {
          ...scene,
          title: 'Identifying local tracks',
          conceptLayout: 'featured',
          items: items([
            ['Field guide', 'Regional mammals', 'book'],
            ['Scope', 'Track shapes and sizes', 'ruler'],
            ['Relevance', 'Species found on local trails', 'map'],
          ]),
        };
        break;
      case 'scope':
        scene = {
          ...scene,
          type: 'boundary',
          title: 'Library membership',
          items: [],
          groups: [
            { label: 'Members', items: ['Borrow books'], icons: ['book'] },
            { label: 'Visitors', items: ['Read on site'], icons: ['armchair'] },
          ],
        };
        break;
    }
    sources[0].markdown = [
      scene.title,
      ...scene.items.map(item => `${item.label}. ${item.detail}.`),
      ...scene.groups.map(group => `${group.label}. ${group.items.join('. ')}.`),
    ].join(' ');
  }
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
  const root = document.getElementById('root');
  if (!root) throw new Error('Fixture root must exist');
  const playbackRoot = createRoot(root);
  function renderBlock(index: number, seekTime?: number) {
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
    if (mixedImage)
      block = {
        ...block,
        visuals: [
          { kind: 'markdown', markdown: '{{PDF_IMAGE:fixture-image|alt=Synthetic image}}' },
        ],
      };
    if (formulaPath === 'scene') {
      block = { ...block, prepared: { scene: formulaSpotlight, motion: [] } };
    }
    if (arithmetic) {
      const scene = {
        ...formulaSpotlight,
        title: 'Multiplication',
        formula: arithmeticSymbols.map(symbol => String.raw`\nousSymbol{${symbol.id}}`).join(''),
        symbols: arithmeticSymbols,
      };
      block = { ...block, prepared: { scene, motion: [] } };
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
      isDarkMode,
      sectionContentBlocks: structuredClone(sources),
      activeSectionAssetsById: mixedImage
        ? {
            'fixture-image': {
              id: 'fixture-image',
              mimeType: 'image/jpeg',
              dataUrl: mixedImageUrl,
              ...(imageAspect
                ? {
                    intrinsicWidth: imageAspect === 'wide' ? 2400 : 240,
                    intrinsicHeight: imageAspect === 'tall' ? 2400 : 240,
                  }
                : {}),
              sourceOrder: 0,
              textBefore: '',
              textAfter: '',
            },
          }
        : {},
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
          time={seekTime ?? duration / 2}
        />
      </div>
    );
  }
  const conceptSurface = new URLSearchParams(location.search).get('concept-surface');
  if (conceptExample && (conceptSurface === 'reader' || conceptSurface === 'thumbnail')) {
    playbackRoot.render(
      <main style={{ width: 'min(100%, 680px)', marginInline: 'auto' }}>
        <LessonSceneVisual
          scene={scene}
          isDarkMode={isDarkMode}
          variant={conceptSurface === 'thumbnail' ? 'thumbnail' : 'card'}
        />
      </main>
    );
  } else {
    renderBlock(formulaPath === 'inherited' ? 1 : 0);
  }
  if (boundaryProof) {
    let index = 0;
    addEventListener('playback-next', () => {
      index = (index + 1) % blocks.length;
      renderBlock(index);
    });
  }
  if (arithmetic)
    addEventListener('arithmetic-seek', event =>
      renderBlock(0, (event as CustomEvent<number>).detail)
    );

  if (snapshotProof) {
    addEventListener('playback-snapshot', () => renderBlock(0));
    addEventListener('playback-short-scene', () => {
      scene = { ...scene, items: scene.items.slice(0, 2) };
      renderBlock(0);
    });
    addEventListener('playback-scene-change', () => {
      scene = { ...scene, title: 'Nuovo contenuto' };
      if (scene.diagram) scene.diagram.nodes[0].label = 'Nuovo programma';
      scene.items[0].value = 10;
      renderBlock(0);
    });
  }
}
