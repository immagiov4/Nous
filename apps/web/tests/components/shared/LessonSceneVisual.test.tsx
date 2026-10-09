// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { LessonScene } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

// The real path data is a 2 MB lazy chunk; one known icon keeps the test deterministic.
vi.mock('@tabler-icon-nodes', () => ({
  default: {
    point: [['circle', { cx: '12', cy: '12', r: '4' }]],
    school: [['path', { d: 'M22 9l-10 -4' }]],
  },
}));

import GeneratedVisualFrame from '../../../components/shared/GeneratedVisualFrame.tsx';
import { LessonSceneVisual } from '../../../components/shared/lessonScene/LessonSceneVisual.tsx';

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
