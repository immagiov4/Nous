// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import ProjectCard from '../../../components/library/ProjectCard.tsx';
import type { SavedProjectMeta } from '../../../types.ts';

const project: SavedProjectMeta = {
  id: 'project-1',
  title: 'Piano di studio',
  sourceKind: 'document',
  createdAt: '2026-05-07T10:00:00.000Z',
  updatedAt: '2026-05-07T10:00:00.000Z',
  lastOpenedAt: '2026-05-07T10:00:00.000Z',
  lessonCount: 28,
  completedCount: 0,
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: 'Game_Engine_Architecture-en.pdf',
  syncState: 'local-only',
};

const originalInnerHeight = window.innerHeight;

describe('ProjectCard', () => {
  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  test('keeps the project action menu attached to the button near the viewport bottom', async () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 400,
    });

    render(
      <ProjectCard
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onMove={vi.fn()}
        onOpen={vi.fn()}
        project={project}
      />
    );

    const actionsButton = screen.getByTitle('Azioni');
    Object.defineProperty(actionsButton, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: 340,
        height: 32,
        left: 760,
        right: 792,
        top: 308,
        width: 32,
        x: 760,
        y: 308,
        toJSON: () => ({}),
      }),
    });

    await userEvent.click(actionsButton);

    const menu = screen.getByText('Esporta').closest('div');

    expect(menu).toHaveStyle({
      bottom: '100px',
      maxHeight: '288px',
    });
  });
});
