// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { type LessonScene, LessonSceneSchema } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';

// The real path data is a 2 MB lazy chunk; one known icon keeps the test deterministic.
vi.mock('@tabler-icon-nodes', () => ({
  default: {
    point: [['circle', { cx: '12', cy: '12', r: '4' }]],
    school: [['path', { d: 'M22 9l-10 -4' }]],
  },
}));

import GeneratedVisualFrame from '../../../components/shared/GeneratedVisualFrame.tsx';
import { LessonSceneVisual } from '../../../components/shared/lessonScene/LessonSceneVisual.tsx';
import { SceneText } from '../../../components/shared/lessonScene/SceneText.tsx';

import { sceneElements } from '../../../components/workspace/playback/stageMotion.ts';

beforeAll(async () => {
  // Load the mocked asset before measuring the component's asynchronous render.
  await import('@tabler-icon-nodes');
});

test('renders a closed loop with a shared center, station details and stable playback targets', () => {
  const scene = LessonSceneSchema.parse({
    type: 'flywheel',
    title: 'Forecasting feedback',
    center: 'Forecast model',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: [
      { label: 'Measure', detail: 'Compare with actual demand', icon: 'point' },
      { label: 'Update', detail: 'Correct the model', icon: 'school' },
      { label: 'Forecast', detail: 'Use the corrected model', icon: 'point' },
    ],
  });
  const { container, rerender } = render(<LessonSceneVisual scene={scene} variant="bare" />);
  expect(screen.getByText('Forecast model')).toBeVisible();
  const stations = [...container.querySelectorAll('.q-cycle-node')];
  expect(stations.map(item => item.textContent)).toEqual([
    'MeasureCompare with actual demand',
    'UpdateCorrect the model',
    'ForecastUse the corrected model',
  ]);
  expect(sceneElements(container, scene).get('item:2')).toContain(stations[2]);
  const arrows = [...container.querySelectorAll('.q-cycle svg > g > path:first-child')];
  expect(arrows).toHaveLength(3);
  const markers = [...container.querySelectorAll<HTMLElement>('.q-cycle-node')];
  arrows.forEach((arrow, index) => {
    const commands = arrow.getAttribute('d')?.split(' ') ?? [];
    const [x, y] = commands.slice(-2).map(Number);
    const distances = markers.map(marker =>
      Math.hypot(Number.parseFloat(marker.style.left) - x, Number.parseFloat(marker.style.top) - y)
    );
    const destination = (index + 1) % markers.length;
    expect(distances[destination]).toBe(Math.min(...distances));
  });

  rerender(
    <LessonSceneVisual scene={{ ...scene, center: undefined, items: scene.items.slice(0, 2) }} />
  );
  expect(screen.queryByText('Forecast model')).toBeNull();
  expect(container.querySelectorAll('.q-cycle-node')).toHaveLength(2);
  expect(container.querySelectorAll('.q-cycle svg > g > path:first-child')).toHaveLength(2);
});

test('distinguishes the primary source from its attributes in a saved concepts scene', () => {
  const scene = LessonSceneSchema.parse({
    type: 'concepts',
    conceptLayout: 'featured',
    title: 'Identifying tracks',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: [
      { label: 'Field guide', detail: 'Regional species', icon: 'school' },
      { label: 'Scope', detail: 'Track shapes', icon: 'school' },
      { label: 'Relevance', detail: 'Local trails', icon: 'school' },
    ],
  });
  const { container } = render(<LessonSceneVisual scene={scene} variant="bare" />);
  expect(container.querySelector('.source-profile')).toHaveTextContent('Field guide');
  expect(container.querySelector('dl')).toHaveTextContent('ScopeTrack shapesRelevanceLocal trails');
  expect(
    [...sceneElements(container, scene)].map(([id, [element]]) => [id, element.textContent])
  ).toEqual([
    ['item:0', 'Field guideRegional species'],
    ['item:1', 'ScopeTrack shapes'],
    ['item:2', 'RelevanceLocal trails'],
  ]);
});

test('shows a shared tree title and root once while preserving nested details and playback targets', () => {
  const scene = LessonSceneSchema.parse({
    type: 'tree',
    title: 'Telescope',
    body: 'Optical assembly',
    note: '',
    quote: '',
    groups: [],
    items: [
      {
        id: 'mount',
        parent: 'scope',
        label: 'Mount',
        detail: 'Holds the optical tube',
        icon: 'point',
      },
      { id: 'scope', label: 'Telescope', detail: '', icon: '' },
      { id: 'lens', parent: 'scope', label: 'Lens', detail: 'Gathers light', icon: 'point' },
    ],
  });
  const { container, rerender } = render(<LessonSceneVisual scene={scene} variant="bare" />);
  expect(screen.getAllByText('Telescope')).toHaveLength(1);
  const heading = screen.getByRole('heading', { name: 'Telescope' });
  const intro = screen.getByText('Optical assembly');
  expect(intro).toBeVisible();
  expect(heading.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const targets = sceneElements(container, scene);
  expect(targets.get('item:1')?.[0]).toContainElement(heading);
  expect(targets.get('item:0')?.[0]).toHaveTextContent('Holds the optical tube');
  expect(targets.get('item:2')?.[0]).toHaveTextContent('Gathers light');
  expect(targets.get('item:0')?.[0]?.parentElement).toBe(targets.get('item:2')?.[0]?.parentElement);

  rerender(<LessonSceneVisual scene={{ ...scene, title: 'Optical equipment' }} />);
  expect(screen.getByRole('heading', { name: 'Optical equipment' })).toBeVisible();
  expect(screen.getByText('Telescope')).toBeVisible();
});

test.each([
  String.raw`\$5 ($x$)`,
  String.raw`\$5 [$x$]`,
  String.raw`\$5: $x$`,
  String.raw`\$5 ($5 + 10$)`,
])('preserves escaped prices beside mathematical notation in %s', copy => {
  const { container } = render(<SceneText>{copy}</SceneText>);
  expect(container.querySelectorAll('math')).toHaveLength(1);
  expect(container.firstChild?.textContent).toBe(
    copy.slice(0, copy.indexOf('$', 2)).replace(String.raw`\$`, '$')
  );
  expect(container.querySelector('annotation')?.textContent).toBe(
    copy.includes('5 + 10') ? '5 + 10' : 'x'
  );
  if (copy.endsWith(')') || copy.endsWith(']')) {
    expect(container.lastChild?.textContent).toBe(copy.at(-1));
  }
});

test.each([
  String.raw`$\mathbf{x}$表示`,
  '$x!$表示',
  '$x^{2}$表示',
])('renders authored math before unspaced prose in %s', copy => {
  const { container } = render(<SceneText>{copy}</SceneText>);
  expect(container.querySelectorAll('math')).toHaveLength(1);
  expect(container.querySelector('annotation')?.textContent).toBe(copy.slice(1, -3));
  expect(container.lastChild?.textContent).toBe('表示');
});

test.each(['network', 'hierarchy'] as const)('omits the heading for an untitled %s', type => {
  const scene = { type, title: '', body: '', items: [], groups: [], quote: '', note: '' };
  const { container } = render(<LessonSceneVisual scene={scene} />);
  expect(container.querySelector('h2')).toBeNull();
});

test.each(['network', 'hierarchy'] as const)('reads the %s root heading before its intro', type => {
  const scene = {
    type,
    title: 'Local observations',
    body: 'The branches describe measurements.',
    items: [{ label: 'Rain', detail: 'Amount over time', icon: '' }],
    groups: [],
    quote: '',
    note: '',
  };
  const { rerender } = render(<LessonSceneVisual scene={scene} />);
  const [heading] = screen.getAllByRole('heading', { name: scene.title });
  const intro = screen.getByText(scene.body);
  expect(screen.getAllByRole('heading', { name: scene.title })).toHaveLength(1);
  expect(heading.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(heading.parentElement).toHaveClass(type === 'network' ? 'hub' : 'root-node');
  expect(screen.getByText('Amount over time')).toBeInTheDocument();
  rerender(<LessonSceneVisual scene={{ ...scene, title: '' }} />);
  expect(screen.queryByRole('heading')).toBeNull();
  expect(screen.getByText(scene.body)).toBeInTheDocument();
});

test('restores a radial name to its ray when the chart has room', () => {
  let resize = () => {};
  let viewportWidth = 320;
  let wideFont = false;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => viewportWidth);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(
    () => (viewportWidth * 420) / 640
  );
  const prototype = SVGElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'getBBox');
  Object.defineProperty(prototype, 'getBBox', {
    configurable: true,
    value(this: SVGTextElement) {
      const long = this.textContent?.includes('Western precision');
      return new DOMRect(long && wideFont && viewportWidth === 320 ? -20 : 30, 0, 120, 24);
    },
  });
  const scene: LessonScene = {
    type: 'radar',
    title: 'Measured precision',
    body: '',
    quote: '',
    note: '',
    groups: [],
    max: 5,
    unit: 'points',
    items: [
      { label: 'Western precision', value: 4, detail: '', icon: '' },
      { label: 'Eastern precision', value: 3, detail: '', icon: '' },
    ],
  };
  try {
    const { container } = render(<LessonSceneVisual scene={scene} />);
    expect(screen.queryByRole('list')).toBeNull();
    wideFont = true;
    document.fonts.dispatchEvent(new Event('loadingdone'));
    expect(sceneElements(container, scene).get('item:0')).toContain(screen.getByRole('listitem'));
    expect(screen.getByRole('listitem')).toHaveTextContent('Western precision: 4 / 5 points');
    viewportWidth = 640;
    act(resize);
    expect(screen.queryByRole('list')).toBeNull();
  } finally {
    if (original) Object.defineProperty(prototype, 'getBBox', original);
    else Reflect.deleteProperty(prototype, 'getBBox');
    vi.unstubAllGlobals();
  }
});

test('fits scatter labels to the resized chart while keeping the authored measurements', () => {
  let width = 0;
  let resize = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(() => (width * 9) / 16);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(90);
  const scene: LessonScene = {
    type: 'scatter',
    title: 'Response times',
    body: '',
    quote: '',
    note: '',
    groups: [],
    xLabel: 'Load',
    yLabel: 'Time (ms)',
    items: [
      { label: 'Baseline trial', x: 1, y: 2, detail: '', icon: '' },
      { label: 'Recalibrated sensor at full load', x: 4, y: 8, detail: '', icon: '' },
    ],
  };
  try {
    const { container } = render(<LessonSceneVisual scene={scene} />);
    const chart = screen.getByRole('img', { name: scene.title });
    expect(chart.querySelector('desc')).toHaveTextContent(
      /Recalibrated sensor at full load: Load 4, Time \(ms\) 8/
    );
    width = 320;
    act(resize);
    const label = within(chart).getByText('Recalibrated sensor at full load');
    expect(label.parentElement).toHaveStyle({ top: '62px', left: '93px' });
    expect(screen.getByRole('list')).toHaveTextContent('Baseline trial');
    const entry = within(screen.getByRole('list')).getByText('Recalibrated sensor at full load');
    expect(sceneElements(container, scene).get('item:1')).toContain(entry);
    expect(chart.style.getPropertyValue('--q-inverse-scale')).toBe('2');
    width = 640;
    act(resize);
    expect(chart.style.getPropertyValue('--q-inverse-scale')).toBe('1');
  } finally {
    vi.unstubAllGlobals();
  }
});

const comparison: LessonScene = {
  body: '',
  groups: [
    {
      icons: ['school', 'search'],
      items: ['Esperienza pertinente', 'Ragioni controllabili'],
      label: 'Competenza verificabile',
    },
    {
      icons: ['id-badge', 'message-circle'],
      items: ['Titolo professionale', 'Tono sicuro'],
      label: 'Sola apparenza',
    },
  ],
  items: [],
  note: 'La fiducia resta aperta alla verifica.',
  quote: '',
  relation: { evidence: 'conta di più', kind: 'greater', label: 'conta di più di' },
  title: 'A che cosa dare più peso?',
  type: 'comparison',
};

test('renders the gradient and both labels from a previously saved continuum', () => {
  const saved = LessonSceneSchema.parse({
    body: '',
    groups: [],
    items: [
      { label: 'Bud', detail: 'Petals are folded.', icon: 'point' },
      { label: 'Flower', detail: 'Petals are open.', icon: 'point' },
    ],
    note: '',
    quote: '',
    title: 'Opening of a flower',
    type: 'continuum',
  });
  const { container } = render(<LessonSceneVisual scene={saved} />);
  expect(container.querySelector('.continuum-line')).toBeInTheDocument();
  expect(screen.getByText('Bud')).toBeVisible();
  expect(screen.getByText('Flower')).toBeVisible();
});

test.each([
  'quote',
] as const)('omits retired %s scenes and renders a meaningful replacement', type => {
  const { container, rerender } = render(
    <LessonSceneVisual scene={{ ...comparison, type, quote: 'Repeated caption.' }} />
  );
  expect(container.innerHTML).toBe('');
  rerender(<LessonSceneVisual scene={comparison} />);
  expect(container.querySelector('h2')?.textContent).toBe('A che cosa dare più peso?');
  expect(container.querySelector('blockquote')).toBeNull();
});

test('preserves the distinct definition layout with its concept icons', () => {
  const { container } = render(
    <LessonSceneVisual
      scene={{
        ...comparison,
        type: 'definition',
        title: 'Componenti del sistema',
        note: '',
        items: [
          { label: 'Processore', detail: 'Esegue le istruzioni', icon: 'point' },
          { label: 'Memoria', detail: 'Conserva i dati', icon: 'point' },
        ],
      }}
    />
  );
  expect(container.querySelector('h2')?.textContent).toBe('Componenti del sistema');
  expect(container.querySelectorAll('.definition .concept-badge')).toHaveLength(2);
  expect(container.querySelector('.definition')?.textContent).toContain('Esegue le istruzioni');
  expect(container.querySelector('blockquote')).toBeNull();
});

test('renders matrix notation without changing the surrounding plain text', () => {
  const scene: LessonScene = {
    ...comparison,
    type: 'matrix',
    criteria: ['Ingresso'],
    groups: [
      { label: 'Vettore', icons: [], items: [String.raw`Prima $\mathbf{x}$ e $\omega_{11}$ dopo`] },
    ],
  };
  const { container } = render(<LessonSceneVisual scene={scene} />);
  const cell = container.querySelector('td');
  expect(cell?.querySelectorAll('math')).toHaveLength(2);
  expect(cell?.querySelectorAll('.katex-html')[0]?.textContent).toBe('x');
  expect(cell?.querySelectorAll('math mi')[1]?.textContent).toBe('ω');
  expect(cell?.textContent).toMatch(/^Prima .* dopo$/u);
});

test.each([
  'card',
  'bare',
] as const)('shows a repeated decision question only in its highlighted box (%s)', variant => {
  const scene: LessonScene = {
    ...comparison,
    type: 'decision',
    body: '  Quando   la conclusione regge? ',
    quote: 'Quando la conclusione regge?',
  };
  const { container, rerender } = render(<LessonSceneVisual scene={scene} variant={variant} />);
  expect(container.querySelector('.scene-intro')).toBeNull();
  expect(container.querySelector('.decision-question')).toHaveTextContent(
    'Quando la conclusione regge?'
  );
  rerender(
    <LessonSceneVisual scene={{ ...scene, body: 'Una premessa diversa.' }} variant={variant} />
  );
  expect(container.querySelector('.scene-intro')).toHaveTextContent('Una premessa diversa.');
  expect(container.querySelector('.decision-question')).toHaveTextContent(
    'Quando la conclusione regge?'
  );
  rerender(<LessonSceneVisual scene={{ ...scene, quote: '' }} variant={variant} />);
  expect(container.querySelector('.scene-intro')).toBeNull();
  expect(container.querySelector('.decision-question')).toHaveTextContent(
    'Quando la conclusione regge?'
  );
});

test.each([
  'card',
  'bare',
] as const)('formats math in the sole highlighted decision question (%s)', variant => {
  const scene: LessonScene = {
    ...comparison,
    type: 'decision',
    body: 'Quando $x^2 > 0$?',
    quote: '',
  };
  const { container, rerender } = render(<LessonSceneVisual scene={scene} variant={variant} />);
  expect(container.querySelector('.scene-intro')).toBeNull();
  expect(container.querySelector('.decision-question math')).toHaveTextContent('x2>0');
  expect(container.querySelector('.decision-question')).not.toHaveTextContent('$');
  rerender(<LessonSceneVisual scene={{ ...scene, quote: scene.body }} variant={variant} />);
  expect(container.querySelector('.scene-intro')).toBeNull();
  expect(container.querySelector('.decision-question math')).toHaveTextContent('x2>0');
});

describe('lesson scene visual', () => {
  test('renders the player scene bare with prototype icon masks and preserves reader cards', async () => {
    const { container, rerender } = render(<LessonSceneVisual scene={comparison} variant="bare" />);
    expect(container.querySelector('figure')).toHaveClass('lesson-scene-bare');
    expect(container.querySelector('li svg')).toBeNull();
    const icon = container.querySelector<HTMLElement>('li .meaning-icon');
    await waitFor(() =>
      expect(decodeURIComponent(icon?.style.getPropertyValue('--icon-url') ?? '')).toContain(
        'M22 9l-10 -4'
      )
    );
    expect(
      screen.getByRole('img', { name: 'conta di più di' }).querySelector('.meaning-icon')
    ).not.toBeNull();
    rerender(<LessonSceneVisual scene={comparison} />);
    expect(container.querySelector('figure')).not.toHaveClass('lesson-scene-bare');
    expect(screen.getByRole('img', { name: 'conta di più di' })).toHaveTextContent('>');
    await waitFor(() => expect(container.querySelector('li svg path')).not.toBeNull());
  });

  test('uses prototype decision options when a bare scene has no question', () => {
    const { container } = render(
      <LessonSceneVisual
        scene={{ ...comparison, body: '', quote: '', type: 'decision' }}
        variant="bare"
      />
    );
    expect(container.querySelector('.decision-question')).toBeNull();
    expect(container.querySelector('.decision-options')).not.toBeNull();
  });
  test.each([
    'checklist',
    'steps',
    'timeline',
    'causal',
    'source',
    'roles',
    'comparison',
    'matrix',
  ] as const)('keeps repeated model entries distinct in a %s scene', type => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const item = { detail: 'Dettaglio', icon: 'point', label: 'Voce' };
    const group = { icons: ['point', 'point'], items: ['Voce', 'Voce'], label: 'Gruppo' };
    const scene = {
      ...comparison,
      criteria: ['Criterio', 'Criterio'],
      groups: [group, group],
      items: [item, item, item],
      note: '',
      type,
    };
    const { container, rerender } = render(<LessonSceneVisual scene={scene} />);
    expect(screen.getAllByText('Voce').length).toBeGreaterThan(1);
    rerender(<LessonSceneVisual scene={{ ...scene, items: [item, item] }} />);
    if (['checklist', 'steps', 'timeline'].includes(type)) {
      expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    }
    expect(errors).not.toHaveBeenCalled();
  });

  test('keeps repeated diagram messages distinct in the connection description', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const edge = { from: 'a', to: 'b', label: 'Richiesta', kind: 'call' as const, evidence: '' };
    const scene: LessonScene = {
      ...comparison,
      type: 'sequence',
      items: [],
      diagram: {
        nodes: [
          { id: 'a', label: 'Alice', kind: 'step' },
          { id: 'b', label: 'Bob', kind: 'step' },
        ],
        edges: [edge, edge],
      },
    };
    const { container } = render(<LessonSceneVisual scene={scene} />);
    expect(container.querySelectorAll('.diagram-description li')).toHaveLength(2);
    expect(container.querySelector('.diagram-description')).toHaveClass('sr-only');
    expect(screen.queryByText('Leggi i collegamenti')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });
  test.each([
    { note: '', quote: '', visible: null },
    { note: ' ', quote: '\n', visible: null },
    { note: '', quote: 'Quali ragioni sostengono questa scelta?', visible: 'Domanda' },
    { note: comparison.note, quote: '', visible: 'Nota' },
    { note: comparison.note, quote: 'Quali ragioni sostengono questa scelta?', visible: null },
  ])('renders at most one closing text: $visible', ({ note, quote, visible }) => {
    const { container } = render(<LessonSceneVisual scene={{ ...comparison, note, quote }} />);

    expect(screen.getByText('Competenza verificabile')).toBeInTheDocument();
    expect(container.querySelectorAll('.scene-note')).toHaveLength(visible ? 1 : 0);
    if (visible) expect(screen.getByLabelText(visible)).toBeInTheDocument();
  });

  test('keeps the primary question in a decision scene', () => {
    const quote = 'Quali ragioni sostengono questa scelta?';
    const { container } = render(
      <LessonSceneVisual scene={{ ...comparison, quote, type: 'decision' }} />
    );

    expect(screen.getByText(quote)).toBeInTheDocument();
    expect(container.querySelectorAll('.scene-note')).toHaveLength(1);
    expect(screen.getByLabelText('Nota')).toBeInTheDocument();
  });

  test('renders grouped entries with their relation and Tabler icons', async () => {
    const { container } = render(<LessonSceneVisual scene={comparison} />);

    expect(screen.getByRole('heading', { name: 'A che cosa dare più peso?' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'conta di più di' })).toHaveTextContent('>');
    expect(screen.getByText('Tono sicuro')).toBeInTheDocument();
    expect(screen.getByLabelText('Nota')).toHaveTextContent(
      'La fiducia resta aperta alla verifica.'
    );
    await waitFor(() =>
      expect(container.querySelector('li svg.meaning-icon path[d="M22 9l-10 -4"]')).not.toBeNull()
    );
  });

  test('renders stored scene visuals inline instead of in a sandboxed frame', async () => {
    const visual: ProjectLessonVisual = {
      createdAt: '2026-10-09T00:00:00.000Z',
      id: 'visual-scene',
      render: { kind: 'scene', scene: comparison },
      slotId: 'slot-scene',
      title: 'Peso della competenza',
    };
    render(
      <GeneratedVisualFrame projectId="project-1" title="Peso della competenza" visual={visual} />
    );

    expect(await screen.findByText('Competenza verificabile')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
