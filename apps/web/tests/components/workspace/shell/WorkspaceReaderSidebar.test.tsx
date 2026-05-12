// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderSidebarModel } from '../../../../components/workspace/shell/types.ts';
import WorkspaceReaderSidebar from '../../../../components/workspace/shell/WorkspaceReaderSidebar.tsx';

const buildProps = (
  overrides: Partial<WorkspaceReaderSidebarModel> = {}
): WorkspaceReaderSidebarModel => ({
  activeSectionId: 'section-1',
  expandedModuleId: 'module-1',
  generatingSectionId: null,
  isLoading: false,
  isMobileViewport: false,
  learningPlanTitle: 'Percorso di Studio',
  onBackToLibrary: vi.fn(),
  onExportProject: vi.fn(),
  onModuleToggle: vi.fn(),
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
    expect(scrollRegion?.className).toContain('min-h-0');
    expect(scrollRegion?.className).toContain('overflow-y-auto');
    expect(scrollRegion?.className).toContain('reader-sidebar-scroll-mobile');
  });
});
