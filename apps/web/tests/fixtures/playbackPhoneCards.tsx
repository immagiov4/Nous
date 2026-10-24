import { type LessonPlaybackBlock, segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { createRoot } from 'react-dom/client';
import LessonPlaybackStage from '../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../components/workspace/shell/types';
import '../../styles/app.css';

export function renderPhoneVisualCards() {
  const params = new URLSearchParams(location.search);
  const kind = params.get('case') || 'steps';
  const base: LessonScene = {
    type: 'steps',
    title: 'Un percorso in tre passi',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [
      {
        label: 'Osserva il problema',
        detail: 'Una persona riconosce una situazione che richiede aiuto.',
        icon: 'eye',
      },
      {
        label: 'Scegli una persona',
        detail: 'La richiesta indica chi può intervenire.',
        icon: 'user',
      },
      {
        label: 'Indica una azione',
        detail: 'Il compito è chiaro per tutte le persone presenti.',
        icon: 'check',
      },
    ],
  };
  const scenes: Record<string, LessonScene> = {
    steps: base,
    comparison: {
      ...base,
      type: 'comparison',
      title: 'Due modi per chiedere aiuto',
      items: [],
      groups: [
        {
          label: 'Richiesta generica',
          items: ['Destinatario incerto', 'Compito incerto'],
          icons: ['user', 'help'],
          verdict: 'avoid',
        },
        {
          label: 'Richiesta efficace',
          items: ['Destinatario preciso', 'Compito preciso'],
          icons: ['user', 'check'],
          verdict: 'prefer',
        },
      ],
    },
    bars: {
      ...base,
      type: 'bars',
      title: 'Restituzioni per gruppo',
      items: [
        { label: 'Persona della maggioranza', detail: '', icon: '', value: 70 },
        { label: 'Persona percepita straniera', detail: '', icon: '', value: 33 },
      ],
    },
    math: {
      ...base,
      type: 'matrix',
      title: 'Rete neurale in forma matriciale',
      items: [],
      criteria: ['Ingresso', 'Uscita'],
      groups: [
        {
          label: 'Vettori',
          icons: [],
          items: [String.raw`$\mathbf{x}$`, String.raw`$\mathbf{h}=\mathbf{\Omega}\mathbf{x}$`],
        },
        {
          label: 'Parametri',
          icons: [],
          items: [String.raw`$\omega_{11}$`, String.raw`$\mathbf{b}$`],
        },
      ],
    },
    prices: {
      ...base,
      type: 'definition',
      title: '$5 today and $10 tomorrow',
      body: 'Budget: $15 now and $20 later.',
      items: [
        { label: '$25 today and $30 tomorrow', detail: 'Formula: $5 + 10$ and $x^2$.', icon: '' },
      ],
    },
    dense: {
      ...base,
      type: 'bars',
      title: 'Sei gruppi a confronto',
      items: Array.from({ length: 6 }, (_, index) => ({
        label: `Persona del gruppo numero ${index + 1}`,
        detail: '',
        icon: '',
        value: 20 + index * 10,
      })),
    },
    missing: {
      ...base,
      type: 'definition',
      title: 'Una scena disponibile',
      items: [base.items[0]],
    },
  };
  const markdown =
    kind === 'missing'
      ? "In una situazione ambigua, le persone osservano gli altri prima di intervenire. Quando nessuno agisce, la calma apparente può rafforzare l'incertezza.\n\n{{PDF_IMAGE:fixture-image|alt=Figura di esempio|caption=Una figura}}"
      : 'La spiegazione descrive gli elementi della figura e le loro relazioni.';
  const sources = [
    {
      type: 'markdown' as const,
      markdown: params.has('heading')
        ? params.get('heading') === 'nested'
          ? `> # Il contesto sociale\n>\n> ${markdown.replaceAll('\n', '\n> ')}`
          : `${params.get('heading') === 'setext' ? 'Il contesto sociale\n=====' : '# Il contesto sociale'}\n\n${markdown}`
        : markdown,
    },
  ];
  const sourceBlock = segmentLessonPlayback(sources)[0];
  const block: LessonPlaybackBlock = {
    ...sourceBlock,
    visuals:
      kind === 'missing'
        ? [{ kind: 'markdown', markdown: markdown.slice(markdown.indexOf('{{')) }]
        : [{ kind: 'scene', scene: scenes[kind] }],
    prepared: {
      ...(params.has('historical') ? {} : { scene: scenes[kind] }),
      motion: [
        {
          effect: 'focus',
          targets: [kind === 'comparison' ? 'group:0' : 'item:0'],
          quote: sourceBlock.speech,
        },
      ],
    },
  };
  document.documentElement.style.cssText =
    '--bg-paper:#fdfbf7;--bg-surface:#fff;--ink-primary:#1f1f1f;--ink-secondary:#4a4a4a;--border-subtle:#e5e7eb';
  const root = document.getElementById('root');
  if (!root) throw new Error('Fixture root must exist');
  createRoot(root).render(
    <div style={{ height: '100dvh', display: 'flex' }}>
      <LessonPlaybackStage
        block={block}
        duration={30}
        time={15}
        content={
          {
            isDarkMode: false,
            sectionContentBlocks: sources,
            activeSectionAssetsById: params.has('asset')
              ? {
                  'fixture-image': {
                    id: 'fixture-image',
                    dataUrl:
                      params.get('asset') === 'broken'
                        ? 'data:image/png;base64,broken'
                        : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="180" height="120"%3E%3Crect width="180" height="120" fill="%23a25031"/%3E%3C/svg%3E',
                  },
                }
              : {},
          } as unknown as WorkspaceReaderContentModel
        }
      />
    </div>
  );
}
