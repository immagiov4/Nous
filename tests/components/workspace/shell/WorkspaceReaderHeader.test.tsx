// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderHeaderModel } from '../../../../components/workspace/shell/types.ts';
import WorkspaceReaderHeader from '../../../../components/workspace/shell/WorkspaceReaderHeader.tsx';

vi.mock('../../../../components/workspace/MusicPlayer.tsx', () => ({
  default: () => <div data-testid="music-player" />,
}));

vi.mock('../../../../components/workspace/shell/WorkspaceReaderSettingsPanel.tsx', () => ({
  default: () => <div data-testid="settings-panel" />,
}));

const buildProps = (): WorkspaceReaderHeaderModel => ({
  activeLaboratoryExercise: null,
  activeSection: {
    id: 'section-1',
    title: 'Lezione 1',
    description: 'Descrizione',
    isCompleted: false,
    type: 'core',
  },
  activeSidebarGroup: null,
  courseGenerationNotes: '',
  isDarkMode: false,
  isFocusMode: false,
  isLoading: false,
  isLaboratoryView: false,
  isMobileSidebarOpen: false,
  isMobileViewport: false,
  isMusicPlaying: false,
  isSettingsOpen: false,
  laboratoryTitle: 'Laboratorio',
  learningPlanTitle: 'Percorso',
  loadingStatus: '',
  modelDefaults: {
    assessmentModel: 'assessment-model',
    contextModel: 'context-model',
    lessonModel: 'lesson-model',
  },
  musicUrl: '',
  musicVolume: 20,
  onBackToLibrary: vi.fn(),
  onOpenSidebar: vi.fn(),
  onRegenerateActiveLaboratoryExercise: vi.fn(),
  onRegenerateActiveSection: vi.fn(),
  onSetDarkMode: vi.fn(),
  onSetCourseGenerationNotes: vi.fn(),
  onSetFocusMode: vi.fn(),
  onSetIsMusicPlaying: vi.fn(),
  onSetMusicUrl: vi.fn(),
  onSetMusicVolume: vi.fn(),
  onSetPreferredOpenRouterModel: vi.fn(),
  onSetSettingsOpen: vi.fn(),
  preferredModels: {
    preferredAssessmentModel: '',
    preferredContextModel: '',
    preferredLessonModel: '',
  },
});

describe('WorkspaceReaderHeader', () => {
  test('asks confirmation before regenerating the current lesson', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} />);

    await user.click(screen.getByRole('button', { name: /Rigenera/i }));

    const dialog = screen.getByRole('dialog', { name: /Conferma rigenerazione contenuto/i });
    expect(dialog).toBeInTheDocument();
    expect(props.onRegenerateActiveSection).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /^Rigenera$/i }));

    expect(props.onRegenerateActiveSection).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('dialog', { name: /Conferma rigenerazione contenuto/i })
    ).not.toBeInTheDocument();
  });

  test('centers the regeneration confirmation dialog on mobile', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} isMobileViewport />);

    await user.click(screen.getByRole('button', { name: /Rigenera il/i }));

    const dialog = screen.getByRole('dialog', { name: /Conferma rigenerazione contenuto/i });
    expect(dialog).toHaveClass('fixed');
    expect(dialog).toHaveClass('left-1/2');
    expect(dialog).toHaveClass('-translate-x-1/2');
  });

  test('shows the actual loading status on mobile instead of a generic label', () => {
    const props = buildProps();

    render(
      <WorkspaceReaderHeader
        {...props}
        isLoading
        isMobileViewport
        loadingStatus="Indice raffinato: 31 lezioni"
      />
    );

    const loadingStatus = screen.getByText('Indice raffinato: 31 lezioni');

    expect(loadingStatus).toBeInTheDocument();
    expect(loadingStatus.parentElement).toHaveClass('w-full');
    expect(loadingStatus.parentElement).toHaveClass('max-w-full');
  });

  test('keeps the music player available on mobile', () => {
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} isMobileViewport />);

    expect(screen.getByTestId('music-player')).toBeInTheDocument();
  });
});
