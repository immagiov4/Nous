// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderSidebarModel } from '../../../../components/workspace/shell/types.ts';
import WorkspaceReaderSidebar from '../../../../components/workspace/shell/WorkspaceReaderSidebar.tsx';

const buildProps = (
  overrides: Partial<WorkspaceReaderSidebarModel> = {}
): WorkspaceReaderSidebarModel => ({
  activeSectionId: 'section-1',
  expandedModuleId: 'module-1',
  generatingSectionId: null,
  isRepairingApplicationExercises: false,
  isLoading: false,
  isMobileViewport: false,
  learningPlanTitle: 'Percorso di Studio',
  repairApplicationExercisesLabel: 'Pianifica esercizi',
  canRepairApplicationExercises: false,
  onBackToLibrary: vi.fn(),
  onExportProject: vi.fn(),
  onModuleToggle: vi.fn(),
  onRepairApplicationExercises: vi.fn(),
  onSelectExercise: vi.fn(),
  onSelectSection: vi.fn(),
  onSetFocusMode: vi.fn(),
  onSetIsMobileSidebarOpen: vi.fn(),
  shouldShowSidebar: true,
  sidebarGroups: [
    {
      id: 'module-1',
      sectionDepthById: { 'section-1': 0 },
      title: 'Controlli tecnici di protezione con un titolo molto lungo',
      sections: [
        {
          kind: 'lesson',
          id: 'section-1',
          title: 'PROTECT: IAM, autenticazione, MFA e accesso privilegiato esteso',
          description: 'Descrizione',
          isCompleted: false,
          type: 'core',
        },
      ],
    },
  ],
  ...overrides,
});

describe('WorkspaceReaderSidebar', () => {
  test('rounds the edge facing the reading content and keeps the scrollbar within it', () => {
    const { container, rerender, unmount } = render(<WorkspaceReaderSidebar {...buildProps()} />);

    expect(container.querySelector('aside')?.classList.contains('rounded-r-[2rem]')).toBe(true);
    expect(container.querySelector('.reader-sidebar-scroll')?.classList.contains('mr-2')).toBe(
      true
    );
    expect(container.querySelector('.reader-sidebar-scroll')?.classList.contains('mb-2')).toBe(
      true
    );

    rerender(<WorkspaceReaderSidebar {...buildProps({ isMobileViewport: true })} />);

    expect(container.querySelector('aside')?.classList.contains('rounded-r-[2rem]')).toBe(true);

    unmount();
  });

  test('uses compositor-only phone motion while preserving the backdrop interaction', () => {
    const onSetIsMobileSidebarOpen = vi.fn();
    const { container, rerender } = render(
      <WorkspaceReaderSidebar
        {...buildProps({
          isMobileViewport: true,
          onSetIsMobileSidebarOpen,
          shouldShowSidebar: false,
        })}
      />
    );

    const sidebar = container.querySelector('aside');
    const backdrop = container.querySelector('button[aria-hidden="true"]');

    expect(sidebar).toHaveClass(
      'transition-transform',
      'duration-300',
      'max-sm:duration-150',
      'max-sm:will-change-transform',
      'max-sm:[transform:translate3d(-100%,0,0)]'
    );
    expect(backdrop).toHaveClass(
      'pointer-events-none',
      'opacity-0',
      'max-sm:backdrop-blur-none',
      'max-sm:transition-opacity',
      'max-sm:will-change-[opacity]'
    );
    expect(backdrop).toBeDisabled();

    rerender(
      <WorkspaceReaderSidebar
        {...buildProps({
          isMobileViewport: true,
          onSetIsMobileSidebarOpen,
          shouldShowSidebar: true,
        })}
      />
    );

    const visibleBackdrop = container.querySelector('button[aria-hidden="false"]');
    if (!(visibleBackdrop instanceof HTMLButtonElement)) {
      throw new Error('Expected the visible mobile sidebar backdrop.');
    }

    expect(sidebar).toHaveClass('max-sm:[transform:translate3d(0,0,0)]');
    expect(visibleBackdrop).toHaveClass('pointer-events-auto', 'opacity-100');
    expect(visibleBackdrop).not.toBeDisabled();

    fireEvent.click(visibleBackdrop);

    expect(onSetIsMobileSidebarOpen).toHaveBeenCalledWith(false);
  });

  test('adds hover tooltips to truncated module and lesson titles', () => {
    render(<WorkspaceReaderSidebar {...buildProps()} />);

    expect(
      screen.getByTitle('Controlli tecnici di protezione con un titolo molto lungo')
    ).toBeInTheDocument();
    expect(
      screen.getByTitle('PROTECT: IAM, autenticazione, MFA e accesso privilegiato esteso')
    ).toBeInTheDocument();
  });

  test('renders application exercise rows separately from lesson rows', () => {
    const onSelectExercise = vi.fn();
    render(
      <WorkspaceReaderSidebar
        {...buildProps({
          onSelectExercise,
          sidebarGroups: [
            {
              id: 'module-1',
              sectionDepthById: { 'section-1': 0, 'exercise-1': 0 },
              title: 'Modulo operativo',
              sections: [
                {
                  kind: 'lesson',
                  id: 'section-1',
                  title: 'Lezione tecnica',
                  description: 'Descrizione',
                  isCompleted: false,
                  type: 'core',
                },
                {
                  kind: 'exercise',
                  id: 'exercise-1',
                  title: 'Laboratorio pratico: Modulo operativo',
                  description: 'Applica il modulo',
                  assessedObjective: 'Dimostrare applicazione pratica',
                  attachments: [],
                  currentFeedback: null,
                  isCompleted: false,
                  feedbackStale: false,
                  updatedAt: '2026-05-12T12:00:00.000Z',
                },
              ],
            },
          ],
        })}
      />
    );

    const exerciseButton = screen.getByRole('button', {
      name: /Laboratorio pratico: Modulo operativo/i,
    });
    expect(screen.getByTitle('Esercizio applicativo pianificato')).toBeInTheDocument();

    fireEvent.click(exerciseButton);

    expect(onSelectExercise).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'exercise-1', kind: 'exercise' })
    );
  });

  test('shows the application exercise repair action when a course needs labs', () => {
    const onRepairApplicationExercises = vi.fn();
    render(
      <WorkspaceReaderSidebar
        {...buildProps({
          canRepairApplicationExercises: true,
          onRepairApplicationExercises,
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Pianifica esercizi/i }));

    expect(onRepairApplicationExercises).toHaveBeenCalledTimes(1);
  });

  test('shows a spinner while application exercise planning is running', () => {
    render(
      <WorkspaceReaderSidebar
        {...buildProps({
          canRepairApplicationExercises: true,
          isRepairingApplicationExercises: true,
        })}
      />
    );

    expect(screen.getByRole('button', { name: /Pianificazione esercizi/i })).toBeDisabled();
  });

  test('opens course feedback directly without duplicating the external course actions', async () => {
    render(<WorkspaceReaderSidebar {...buildProps()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Segnala problema' }));
    const feedbackDialog = screen.getByRole('dialog', { name: 'Segnala un problema' });
    expect(feedbackDialog).toBeInTheDocument();

    fireEvent.click(within(feedbackDialog).getByRole('button', { name: 'Chiudi segnalazione' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Segnala problema' })).toHaveFocus()
    );

    expect(screen.queryByLabelText(/Azioni corso/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Esporta' })).not.toBeInTheDocument();
  });

  test('hides the repair action once no repair is needed and no planning is running', () => {
    render(
      <WorkspaceReaderSidebar
        {...buildProps({
          canRepairApplicationExercises: false,
          isRepairingApplicationExercises: false,
        })}
      />
    );

    expect(screen.queryByRole('button', { name: /Pianifica esercizi/i })).toBeNull();
  });
});
