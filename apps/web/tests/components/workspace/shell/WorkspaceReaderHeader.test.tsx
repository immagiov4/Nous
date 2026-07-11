// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderHeaderModel } from '../../../../components/workspace/shell/types.ts';
import WorkspaceReaderHeader from '../../../../components/workspace/shell/WorkspaceReaderHeader.tsx';

vi.mock('../../../../components/workspace/UnifiedAudioPanel.tsx', () => ({
  default: () => <div data-testid="music-player" />,
}));

vi.mock('../../../../components/workspace/shell/WorkspaceReaderSettingsPanel.tsx', () => ({
  default: () => <div data-testid="settings-panel" />,
}));

const buildProps = (): WorkspaceReaderHeaderModel => ({
  activeSectionId: 'section-1',
  activeSectionTitle: 'Lezione 1',
  activeSidebarGroup: null,
  hasActiveSection: true,
  courseGenerationNotes: '',
  isDarkMode: false,
  isFocusMode: false,
  isLoading: false,
  isMobileSidebarOpen: false,
  isMobileViewport: false,
  isMusicPlaying: false,
  syncState: 'saved',
  isSettingsOpen: false,
  learningPlanTitle: 'Percorso',
  learningAids: [],
  loadingStatus: '',
  musicUrl: '',
  musicVolume: 20,
  onBackToLibrary: vi.fn(),
  onOpenSidebar: vi.fn(),
  onRegenerateActiveSection: vi.fn(),
  onSaveLearningAids: vi.fn(async () => true),
  onSetDarkMode: vi.fn(),
  onSetCourseGenerationNotes: vi.fn(),
  onSetFocusMode: vi.fn(),
  onSetIsMusicPlaying: vi.fn(),
  onSetMusicUrl: vi.fn(),
  onSetMusicVolume: vi.fn(),
  onSetSettingsOpen: vi.fn(),
  onSetSettingsPanelExpandedSections: vi.fn(),
  lastAudioTab: 'voce',
  onSetLastAudioTab: vi.fn(),
  settingsPanelExpandedSections: ['course-notes'],
  tts: {
    availableVoices: [],
    chunkOptions: [],
    currentChunkIndex: 0,
    currentTime: 0,
    currentVoice: 'coral' as const,
    duration: 0,
    isPlaying: false,
    isLoading: false,
    isTextPickerActive: false,
    playbackRate: 1,
    sectionContent: '',
    ttsConnected: false,
    onPlayPause: vi.fn(),
    onSeek: vi.fn(),
    onSelectChunk: vi.fn(),
    onSetTextPickerActive: vi.fn(),
    onSkipChunk: vi.fn(),
    onSpeedChange: vi.fn(),
    onVoiceChange: vi.fn(),
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

    await user.click(screen.getByRole('button', { name: /Rigenera la/i }));

    const dialog = screen.getByRole('dialog', { name: /Conferma rigenerazione contenuto/i });
    expect(dialog).toHaveClass('fixed');
    expect(dialog).toHaveClass('left-1/2');
    expect(dialog).toHaveClass('-translate-x-1/2');
  });

  test('hides the regeneration confirmation while the lesson is loading', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    const { rerender } = render(<WorkspaceReaderHeader {...props} />);

    await user.click(screen.getByRole('button', { name: /Rigenera/i }));
    expect(
      screen.getByRole('dialog', { name: /Conferma rigenerazione contenuto/i })
    ).toBeInTheDocument();

    rerender(<WorkspaceReaderHeader {...props} isLoading />);

    expect(
      screen.queryByRole('dialog', { name: /Conferma rigenerazione contenuto/i })
    ).not.toBeInTheDocument();
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

  test('keeps database saving silent while preserving save errors', () => {
    const props = buildProps();
    const { rerender } = render(
      <WorkspaceReaderHeader {...props} isMobileViewport syncState="saving" />
    );

    expect(screen.queryByText('Salvataggio')).not.toBeInTheDocument();

    rerender(<WorkspaceReaderHeader {...props} isMobileViewport syncState="error" />);

    expect(screen.getByText('Errore')).toBeInTheDocument();
  });

  test('keeps the music player available on mobile', () => {
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} isMobileViewport />);

    expect(screen.getByTestId('music-player')).toBeInTheDocument();
  });

  test('opens desktop key concepts from the sticky header without showing a count', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(
      <WorkspaceReaderHeader
        {...props}
        learningAids={[
          {
            id: 'learning-aid-definition-vlan',
            kind: 'definition',
            title: 'VLAN',
            content: 'Una rete locale separata logicamente.',
          },
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Apri concetti chiave' }));

    expect(screen.getByRole('complementary', { name: 'Concetti chiave' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Espandi VLAN' })).toBeInTheDocument();
    expect(screen.queryByText('1 elemento')).toBeNull();
  });
});
