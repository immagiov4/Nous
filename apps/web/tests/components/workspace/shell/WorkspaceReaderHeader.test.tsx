// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
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
  learningAids: [],
  loadingStatus: '',
  musicUrl: '',
  musicVolume: 20,
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

  test('keeps mobile dark mode and keyboard focus inside the portaled confirmation', async () => {
    const user = userEvent.setup();

    render(<WorkspaceReaderHeader {...buildProps()} isDarkMode isMobileViewport />);

    const trigger = screen.getByRole('button', { name: /Rigenera la/i });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: /Conferma rigenerazione contenuto/i });
    const cancelButton = within(dialog).getByRole('button', { name: 'Annulla' });
    const confirmButton = within(dialog).getByRole('button', { name: /^Rigenera$/i });
    expect(dialog).toHaveClass('dark');
    expect(cancelButton).toHaveFocus();

    await user.tab();
    expect(confirmButton).toHaveFocus();
    await user.tab();
    expect(cancelButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirmButton).toHaveFocus();

    await user.click(cancelButton);
    expect(trigger).toHaveFocus();
  });

  test('rebuilds the focus trap when the open confirmation changes layout', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    const { rerender } = render(<WorkspaceReaderHeader {...props} isMobileViewport />);

    await user.click(screen.getByRole('button', { name: /Rigenera la/i }));
    const mobileDialog = screen.getByRole('dialog', {
      name: /Conferma rigenerazione contenuto/i,
    });
    const mobileCancelButton = within(mobileDialog).getByRole('button', { name: 'Annulla' });
    expect(mobileCancelButton).toHaveFocus();

    rerender(<WorkspaceReaderHeader {...props} isMobileViewport={false} />);

    const desktopDialog = screen.getByRole('dialog', {
      name: /Conferma rigenerazione contenuto/i,
    });
    const desktopCancelButton = within(desktopDialog).getByRole('button', { name: 'Annulla' });
    const desktopConfirmButton = within(desktopDialog).getByRole('button', { name: /^Rigenera$/i });
    expect(mobileCancelButton).not.toBeInTheDocument();
    expect(desktopCancelButton).toHaveFocus();

    await user.tab();
    expect(desktopConfirmButton).toHaveFocus();
    await user.tab();
    expect(desktopCancelButton).toHaveFocus();
  });

  test('dismisses the mobile regeneration confirmation when pressing outside its card', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} isMobileViewport />);

    await user.click(screen.getByRole('button', { name: /Rigenera la/i }));

    await user.click(screen.getByRole('dialog', { name: /Conferma rigenerazione contenuto/i }));

    expect(
      screen.queryByRole('dialog', { name: /Conferma rigenerazione contenuto/i })
    ).not.toBeInTheDocument();
    expect(props.onRegenerateActiveSection).not.toHaveBeenCalled();
  });

  test('keeps the mobile regeneration confirmation open when pressing its card', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} isMobileViewport />);

    await user.click(screen.getByRole('button', { name: /Rigenera la/i }));

    const dialog = screen.getByRole('dialog', { name: /Conferma rigenerazione contenuto/i });
    await user.click(within(dialog).getByText('Rigenerare questa lezione?'));

    expect(dialog).toBeInTheDocument();
    expect(props.onRegenerateActiveSection).not.toHaveBeenCalled();
  });

  test('dismisses the desktop regeneration confirmation when pressing outside its card', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} />);

    await user.click(screen.getByRole('button', { name: /Rigenera/i }));
    await user.click(document.body);

    expect(
      screen.queryByRole('dialog', { name: /Conferma rigenerazione contenuto/i })
    ).not.toBeInTheDocument();
    expect(props.onRegenerateActiveSection).not.toHaveBeenCalled();
  });

  test('keeps the desktop regeneration confirmation open when pressing its card', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} />);

    await user.click(screen.getByRole('button', { name: /Rigenera/i }));

    const dialog = screen.getByRole('dialog', { name: /Conferma rigenerazione contenuto/i });
    await user.click(within(dialog).getByText('Rigenerare questa lezione?'));

    expect(dialog).toBeInTheDocument();
    expect(props.onRegenerateActiveSection).not.toHaveBeenCalled();
  });

  test('cancels the regeneration confirmation without regenerating', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} />);

    await user.click(screen.getByRole('button', { name: /Rigenera/i }));
    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(
      screen.queryByRole('dialog', { name: /Conferma rigenerazione contenuto/i })
    ).not.toBeInTheDocument();
    expect(props.onRegenerateActiveSection).not.toHaveBeenCalled();
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

  test('does not reserve an empty mobile status row when the reader is idle', () => {
    const props = buildProps();
    const { rerender } = render(<WorkspaceReaderHeader {...props} isMobileViewport />);

    expect(screen.getByRole('banner').children).toHaveLength(1);

    rerender(<WorkspaceReaderHeader {...props} isLoading isMobileViewport />);

    expect(screen.getByRole('banner').children).toHaveLength(2);
  });

  test('uses transparent floating controls on the phone header', () => {
    render(<WorkspaceReaderHeader {...buildProps()} isMobileViewport />);

    expect(screen.getByRole('banner')).toHaveClass('pointer-events-none');
    expect(screen.getByRole('banner')).toHaveClass('absolute');
    expect(screen.getByRole('banner')).toHaveClass('top-0');
    expect(screen.getByRole('banner')).not.toHaveClass('relative');
    expect(screen.getByRole('banner')).not.toHaveClass('rounded-2xl');
    expect(screen.getByRole('banner')).not.toHaveClass('min-h-[4rem]');
  });

  test('keeps the music player available on mobile', () => {
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} isMobileViewport />);

    expect(screen.getByTestId('music-player')).toBeInTheDocument();
  });

  test('closes mobile key concepts when pressing outside the panel', async () => {
    const user = userEvent.setup();

    render(<WorkspaceReaderHeader {...buildProps()} isMobileViewport />);

    await user.click(screen.getByRole('button', { name: 'Apri concetti chiave' }));
    expect(screen.getByRole('complementary', { name: 'Concetti chiave' })).toBeInTheDocument();

    await user.click(document.body);

    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: 'Concetti chiave' })
      ).not.toBeInTheDocument();
    });
  });

  test('closes mobile key concepts with Escape', async () => {
    const user = userEvent.setup();

    render(<WorkspaceReaderHeader {...buildProps()} isMobileViewport />);

    await user.click(screen.getByRole('button', { name: 'Apri concetti chiave' }));
    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('complementary', { name: 'Concetti chiave' })
    ).not.toBeInTheDocument();
  });

  test('keeps only the reader controls in the mobile floating header', () => {
    const props = buildProps();

    render(<WorkspaceReaderHeader {...props} isMobileViewport />);

    expect(screen.queryByText('Lezione 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apri elenco lezioni' })).toHaveClass('h-11', 'w-11');
    expect(
      screen.getByRole('button', { name: 'Rigenera la lezione corrente' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('music-player')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apri concetti chiave' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apri impostazioni lettura' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cambia Tema' })).toBeInTheDocument();
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
