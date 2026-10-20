// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderHeaderModel } from '../../../../components/workspace/shell/types.ts';
import WorkspaceReaderHeader from '../../../../components/workspace/shell/WorkspaceReaderHeader.tsx';
import { setAccountLocale } from '../../../../i18n/uiMessages.ts';

vi.mock('../../../../components/workspace/UnifiedAudioPanel.tsx', () => ({
  default: () => <div data-testid="music-player" />,
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
  onPlayLesson: vi.fn(),
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
    onStop: vi.fn(),
    onSeek: vi.fn(),
    onSelectChunk: vi.fn(),
    onSetTextPickerActive: vi.fn(),
    onSkipChunk: vi.fn(),
    onSpeedChange: vi.fn(),
    onVoiceChange: vi.fn(),
  },
});

function Header(props: WorkspaceReaderHeaderModel) {
  const [open, setOpen] = useState(props.isSettingsOpen);
  return (
    <WorkspaceReaderHeader
      {...props}
      isSettingsOpen={open}
      onSetSettingsOpen={value => {
        setOpen(value);
        props.onSetSettingsOpen(value);
      }}
    />
  );
}

describe('WorkspaceReaderHeader', () => {
  test('opens playback from the header and keeps regeneration in settings', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    render(<Header {...props} />);
    await user.click(screen.getByRole('button', { name: /Riproduci/i }));
    expect(props.onPlayLesson).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /^Rigenera$/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Apri impostazioni lettura' }));
    expect(screen.getByRole('button', { name: /^Rigenera$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Istruzioni personalizzate' })).toBeInTheDocument();
  });
  test.each([
    false,
    true,
  ])('starts regeneration after confirmation, mobile=%s', async isMobileViewport => {
    const user = userEvent.setup();
    const props = buildProps();
    render(<Header {...props} isMobileViewport={isMobileViewport} isSettingsOpen />);
    await user.click(screen.getByRole('button', { name: 'Rigenera' }));
    expect(props.onRegenerateActiveSection).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sì, rigenera' }));
    expect(props.onRegenerateActiveSection).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('uses the account locale for the regeneration action', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    const view = render(<Header {...props} isSettingsOpen />);
    try {
      act(() => setAccountLocale('en'));
      await user.click(screen.getByRole('button', { name: 'Regenerate' }));
      await user.click(screen.getByRole('button', { name: 'Yes, regenerate' }));
      expect(props.onRegenerateActiveSection).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      setAccountLocale(null);
    }
  });

  test.each([
    { isLoading: true, hasActiveSection: true },
    { isLoading: false, hasActiveSection: false },
  ])('disables regeneration when unavailable: %o', async availability => {
    const user = userEvent.setup();
    const props = buildProps();
    render(<Header {...props} {...availability} isSettingsOpen />);
    const regenerate = screen.getByRole('button', { name: 'Rigenera' });
    expect(regenerate).toBeDisabled();
    await user.click(regenerate);
    expect(props.onRegenerateActiveSection).not.toHaveBeenCalled();
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
    const { rerender } = render(<Header {...props} isMobileViewport syncState="saving" />);

    expect(screen.queryByText('Salvataggio')).not.toBeInTheDocument();

    rerender(<Header {...props} isMobileViewport syncState="error" />);

    expect(screen.getByText('Errore')).toBeInTheDocument();
  });

  test('does not reserve an empty mobile status row when the reader is idle', () => {
    const props = buildProps();
    const { rerender } = render(<Header {...props} isMobileViewport />);

    expect(screen.getByRole('banner').children).toHaveLength(1);

    rerender(<Header {...props} isLoading isMobileViewport />);

    expect(screen.getByRole('banner').children).toHaveLength(2);
  });

  test('uses transparent floating controls on the phone header', () => {
    render(<Header {...buildProps()} isMobileViewport />);

    expect(screen.getByRole('banner')).toHaveClass('pointer-events-none');
    expect(screen.getByRole('banner')).toHaveClass('absolute');
    expect(screen.getByRole('banner')).toHaveClass('top-0');
    expect(screen.getByRole('banner')).not.toHaveClass('relative');
    expect(screen.getByRole('banner')).not.toHaveClass('rounded-2xl');
    expect(screen.getByRole('banner')).not.toHaveClass('min-h-[4rem]');
  });

  test('keeps the music player available on mobile', () => {
    const props = buildProps();

    render(<Header {...props} isMobileViewport />);

    expect(screen.getByTestId('music-player')).toBeInTheDocument();
  });

  test('closes mobile key concepts when pressing outside the panel', async () => {
    const user = userEvent.setup();

    render(<Header {...buildProps()} isMobileViewport />);

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

    render(<Header {...buildProps()} isMobileViewport />);

    await user.click(screen.getByRole('button', { name: 'Apri concetti chiave' }));
    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('complementary', { name: 'Concetti chiave' })
    ).not.toBeInTheDocument();
  });

  test('keeps only the reader controls in the mobile floating header', () => {
    const props = buildProps();

    render(<Header {...props} isMobileViewport />);

    expect(screen.queryByText('Lezione 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apri elenco lezioni' })).toHaveClass('h-11', 'w-11');
    expect(
      screen.getByRole('button', { name: 'Riproduci la lezione corrente' })
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
