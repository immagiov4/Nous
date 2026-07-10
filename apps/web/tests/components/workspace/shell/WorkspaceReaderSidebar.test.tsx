// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
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
  test('adds hover tooltips to truncated module and lesson titles', () => {
    render(<WorkspaceReaderSidebar {...buildProps()} />);

    expect(
      screen.getByTitle('Controlli tecnici di protezione con un titolo molto lungo')
    ).toBeInTheDocument();
    expect(
      screen.getByTitle('PROTECT: IAM, autenticazione, MFA e accesso privilegiato esteso')
    ).toBeInTheDocument();
  });

  test('constrains the mobile sidebar to the dynamic viewport and keeps its body scrollable', () => {
    const { container } = render(
      <WorkspaceReaderSidebar {...buildProps({ isMobileViewport: true })} />
    );

    const sidebar = container.querySelector('aside');
    const scrollRegion = container.querySelector('aside > div:last-of-type');

    expect(sidebar?.style.height).toBe('100dvh');
    expect(sidebar?.style.maxHeight).toBe('100dvh');
    expect(scrollRegion?.className).toContain('custom-scrollbar');
    expect(scrollRegion?.className).toContain('min-h-0');
    expect(scrollRegion?.className).toContain('overflow-y-auto');
    expect(scrollRegion?.className).toContain('reader-sidebar-scroll-mobile');
  });

  test('uses container positioning when embedded in the public product demo', () => {
    const { container } = render(
      <WorkspaceReaderSidebar {...buildProps({ placement: 'container' })} />
    );

    const sidebar = container.querySelector('aside');
    expect(sidebar?.className).toContain('absolute');
    expect(sidebar?.className).not.toContain('fixed');
    expect(sidebar?.style.height).toBe('100%');
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

  test('renders the configured planning label', () => {
    render(
      <WorkspaceReaderSidebar
        {...buildProps({
          canRepairApplicationExercises: true,
          repairApplicationExercisesLabel: 'Pianifica esercizi',
        })}
      />
    );

    expect(screen.getByRole('button', { name: /Pianifica esercizi/i })).toBeVisible();
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
