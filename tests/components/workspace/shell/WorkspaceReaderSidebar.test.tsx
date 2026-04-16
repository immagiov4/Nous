// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderSidebarModel } from '../../../../components/workspace/shell/types.ts';
import WorkspaceReaderSidebar from '../../../../components/workspace/shell/WorkspaceReaderSidebar.tsx';

const buildProps = (
  overrides: Partial<WorkspaceReaderSidebarModel> = {}
): WorkspaceReaderSidebarModel => ({
  activeLaboratoryExerciseId: null,
  activeSectionId: 'section-1',
  expandedModuleId: 'module-1',
  isLoading: false,
  isMobileViewport: false,
  laboratoryExercises: [],
  laboratoryStatus: null,
  laboratoryTitle: 'Laboratorio',
  learningPlanTitle: 'Percorso di Studio',
  onBackToLibrary: vi.fn(),
  onExportProject: vi.fn(),
  onGenerateLaboratory: vi.fn(),
  onModuleToggle: vi.fn(),
  onSelectLaboratoryExercise: vi.fn(),
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

  test('shows the laboratory generation entry point when no exercise exists yet', () => {
    render(<WorkspaceReaderSidebar {...buildProps()} />);

    expect(screen.getByText('Genera laboratorio')).toBeInTheDocument();
  });

  test('exposes the temporary full laboratory regeneration action from the laboratory context menu', () => {
    const onRegenerateLaboratoryIndex = vi.fn();

    render(
      <WorkspaceReaderSidebar
        {...buildProps({
          laboratoryExercises: [
            {
              attachments: [],
              approachMarkdown: '## Metodo\n\nParti dai requisiti.',
              brief: 'Consegna pratica.',
              evaluation: null,
              exampleMarkdown: '## Indizio\n\nParti da un caso semplice.',
              generatedAt: '2026-04-07T10:00:00.000Z',
              id: 'lab-1',
              instructionsMarkdown: '## Scenario\n\nCaso tecnico.',
              internalNotes: [],
              requirements: ['Vincolo 1'],
              title: 'Esercizio 1',
              updatedAt: '2026-04-07T10:00:00.000Z',
            },
          ],
          laboratoryStatus: 'ready',
          onRegenerateLaboratoryIndex,
        })}
      />
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Laboratorio' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rigenera intero laboratorio' }));

    expect(onRegenerateLaboratoryIndex).toHaveBeenCalledTimes(1);
  });

  test('shows generated laboratory exercises with the hollow-dot status instead of the lesson minus icon', () => {
    render(
      <WorkspaceReaderSidebar
        {...buildProps({
          activeSectionId: null,
          sidebarGroups: [],
          laboratoryExercises: [
            {
              attachments: [],
              approachMarkdown: '## Metodo\n\nParti dai requisiti.',
              brief: 'Consegna pratica.',
              evaluation: null,
              exampleMarkdown: '## Indizio\n\nParti da un caso semplice.',
              generatedAt: '2026-04-07T10:00:00.000Z',
              id: 'lab-1',
              instructionsMarkdown: '## Scenario\n\nCaso tecnico.',
              internalNotes: [],
              requirements: ['Vincolo 1'],
              title: 'Esercizio 1',
              updatedAt: '2026-04-07T10:00:00.000Z',
            },
          ],
          laboratoryStatus: 'ready',
        })}
      />
    );

    expect(screen.getByTitle('Esercizio laboratorio gia generato')).toBeInTheDocument();
  });

  test('renders the laboratory section after lesson sections', () => {
    const { container } = render(<WorkspaceReaderSidebar {...buildProps()} />);

    const renderedText = container.textContent || '';
    expect(
      renderedText.indexOf('PROTECT: IAM, autenticazione, MFA e accesso privilegiato esteso')
    ).toBeLessThan(renderedText.indexOf('Laboratorio'));
  });

  test('constrains the mobile sidebar to the dynamic viewport and keeps its body scrollable', () => {
    const { container } = render(
      <WorkspaceReaderSidebar {...buildProps({ isMobileViewport: true })} />
    );

    const sidebar = container.querySelector('aside');
    const scrollRegion = container.querySelector('aside > div:last-of-type');

    expect(sidebar?.style.height).toBe('100dvh');
    expect(sidebar?.style.maxHeight).toBe('100dvh');
    expect(scrollRegion?.className).toContain('min-h-0');
    expect(scrollRegion?.className).toContain('overflow-y-auto');
    expect((scrollRegion as HTMLDivElement | null)?.style.paddingBottom).toBe(
      'max(1.25rem, env(safe-area-inset-bottom, 0px))'
    );
  });
});
