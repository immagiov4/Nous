// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { LessonScene } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import { render, screen, waitFor } from '@testing-library/react';
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

beforeAll(async () => {
  // Load the mocked asset before measuring the component's asynchronous render.
  await import('@tabler-icon-nodes');
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

  test.each([
    'quote',
    'decision',
  ] as const)('keeps the primary quotation or question in a %s scene', type => {
    const quote = 'Quali ragioni sostengono questa scelta?';
    const { container } = render(<LessonSceneVisual scene={{ ...comparison, quote, type }} />);

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
