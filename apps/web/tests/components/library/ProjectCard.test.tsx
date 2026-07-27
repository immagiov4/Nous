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
};

const originalInnerHeight = globalThis.innerHeight;

describe('ProjectCard', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    });
  });

  test('renders library controls in the browser language', () => {
    Object.defineProperties(globalThis.navigator, {
      language: { configurable: true, value: 'en-GB' },
      languages: { configurable: true, value: ['en-GB'] },
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

    expect(screen.getByText('28 lessons')).toBeInTheDocument();
    expect(screen.getByTitle('Actions')).toBeInTheDocument();
  });

  test('keeps the project action menu attached to the button near the viewport bottom', async () => {
    Object.defineProperty(globalThis, 'innerHeight', {
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

  test('renames from a title double click without opening the project', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onRename = vi.fn(async () => {});

    render(
      <ProjectCard
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onOpen={onOpen}
        onRename={onRename}
        project={project}
      />
    );

    await user.dblClick(screen.getByRole('button', { name: project.title }));

    const input = screen.getByRole('textbox', { name: /Rinomina corso|Rename course/ });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'Architettura dei giochi{Enter}');

    expect(onRename).toHaveBeenCalledWith(project.id, 'Architettura dei giochi');
    expect(onOpen).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: project.title }));
    expect(onOpen).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /lezioni/i }));
    expect(onOpen).toHaveBeenCalledWith(project.id);
  });
});
