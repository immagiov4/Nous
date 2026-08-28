// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderTtsModel } from '../../../components/workspace/shell/types.ts';
import UnifiedAudioPanel from '../../../components/workspace/UnifiedAudioPanel.tsx';

const buildTtsModel = (
  overrides: Partial<WorkspaceReaderTtsModel> & Record<string, unknown> = {}
): WorkspaceReaderTtsModel =>
  ({
    availableVoices: [{ id: 'alloy', label: 'Alloy', language: 'en' }],
    chunkOptions: [
      { index: 0, label: 'Parte 1 — Introduzione alle reti' },
      { index: 1, label: 'Parte 2 — Collegamenti e protocolli' },
      { index: 2, label: 'Parte 3 — Instradamento dei pacchetti' },
    ],
    currentChunkIndex: 0,
    currentTime: 0,
    currentVoice: 'alloy',
    duration: 180,
    isLoading: false,
    isPlaying: false,
    isTextPickerActive: false,
    onPlayPause: () => {},
    onSeek: () => {},
    onSelectChunk: () => {},
    onSetTextPickerActive: () => {},
    onSkipChunk: () => {},
    onSpeedChange: () => {},
    onVoiceChange: () => {},
    playbackRate: 1,
    sectionContent: 'Contenuto di test',
    ttsConnected: true,
    ...overrides,
  }) as WorkspaceReaderTtsModel;

const AudioHarness = ({ initialMusicUrl = '' }: { initialMusicUrl?: string }) => {
  const [musicUrl, setMusicUrl] = useState(initialMusicUrl);
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [musicVolume, setMusicVolume] = useState(60);

  return (
    <UnifiedAudioPanel
      initialTab="ambiente"
      isOpen
      isMusicPlaying={isMusicPlaying}
      musicUrl={musicUrl}
      musicVolume={musicVolume}
      setIsMusicPlaying={setIsMusicPlaying}
      setMusicUrl={setMusicUrl}
      setMusicVolume={setMusicVolume}
      tts={buildTtsModel()}
    />
  );
};

describe('UnifiedAudioPanel', () => {
  test('centers the panel on phones and restores icon anchoring from the tablet breakpoint', () => {
    const { container } = render(
      <UnifiedAudioPanel
        initialTab="voce"
        isMobileViewport
        isOpen
        isMusicPlaying={false}
        musicUrl=""
        musicVolume={60}
        setIsMusicPlaying={() => {}}
        setMusicUrl={() => {}}
        setMusicVolume={() => {}}
        tts={buildTtsModel()}
      />
    );

    const panel = container.querySelector('[data-audio-panel-positioner]');
    expect(panel).toHaveClass('fixed', 'left-1/2', '-translate-x-1/2');
    expect(panel).toHaveClass('sm:absolute', 'sm:right-0', 'sm:left-auto', 'sm:translate-x-0');
  });

  test('shows how many speech parts exist and lets the user choose one directly', async () => {
    const user = userEvent.setup();
    const onSelectChunk = vi.fn();

    render(
      <UnifiedAudioPanel
        initialTab="voce"
        isOpen
        isMusicPlaying={false}
        musicUrl=""
        musicVolume={60}
        setIsMusicPlaying={() => {}}
        setMusicUrl={() => {}}
        setMusicVolume={() => {}}
        tts={buildTtsModel({ currentChunkIndex: 1, onSelectChunk })}
      />
    );

    expect(screen.getByText('Parte 2 di 3')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Parte da leggere' }), '2');
    expect(onSelectChunk).toHaveBeenCalledWith(2);
  });

  test('starts direct selection from the lesson text', async () => {
    const user = userEvent.setup();
    const onSetTextPickerActive = vi.fn();

    render(
      <UnifiedAudioPanel
        initialTab="voce"
        isOpen
        isMusicPlaying={false}
        musicUrl=""
        musicVolume={60}
        setIsMusicPlaying={() => {}}
        setMusicUrl={() => {}}
        setMusicVolume={() => {}}
        tts={buildTtsModel({ onSetTextPickerActive })}
      />
    );

    const textPickerButton = screen.getByRole('button', { name: 'Scegli dal testo' });
    expect(textPickerButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(textPickerButton);

    expect(onSetTextPickerActive).toHaveBeenCalledWith(true);
  });

  test('shows one stable playback error instead of provider details', () => {
    render(
      <UnifiedAudioPanel
        initialTab="voce"
        isOpen
        isMusicPlaying={false}
        musicUrl=""
        musicVolume={60}
        setIsMusicPlaying={() => {}}
        setMusicUrl={() => {}}
        setMusicVolume={() => {}}
        tts={buildTtsModel({
          errorMessage: 'Non sono riuscito a generare l’audio. Riprova tra poco.',
        })}
      />
    );

    expect(
      screen.getByText('Non sono riuscito a generare l’audio. Riprova tra poco.')
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('502');
  });

  test('keeps the panel open while the user clicks a part in the lesson', () => {
    const onToggle = vi.fn();

    render(
      <UnifiedAudioPanel
        initialTab="voce"
        isOpen
        isMusicPlaying={false}
        musicUrl=""
        musicVolume={60}
        onToggle={onToggle}
        setIsMusicPlaying={() => {}}
        setMusicUrl={() => {}}
        setMusicVolume={() => {}}
        tts={buildTtsModel({ isTextPickerActive: true })}
      />
    );

    fireEvent.pointerDown(document.body);

    expect(onToggle).not.toHaveBeenCalled();
  });

  test('shows the playback speed as a direct dial without a secondary slider', () => {
    render(
      <UnifiedAudioPanel
        initialTab="voce"
        isOpen
        isMusicPlaying={false}
        musicUrl=""
        musicVolume={60}
        setIsMusicPlaying={() => {}}
        setMusicUrl={() => {}}
        setMusicVolume={() => {}}
        tts={buildTtsModel()}
      />
    );

    const speedDial = screen.getByRole('slider', { name: 'Velocita' });
    expect(speedDial).toHaveAttribute('aria-valuemin', '0.8');
    expect(speedDial).toHaveAttribute('aria-valuemax', '1.6');
    expect(speedDial).toHaveAttribute('aria-valuenow', '1');
    expect(speedDial).toHaveAttribute('aria-valuetext', '1x');
    expect(speedDial).toHaveTextContent('1x');
    expect(document.querySelector('input[type="range"][min="0.8"]')).toBeNull();
  });

  test('synchronizes an out-of-range playback speed through the existing update path', () => {
    const onSpeedChange = vi.fn();
    render(
      <UnifiedAudioPanel
        initialTab="voce"
        isOpen
        isMusicPlaying={false}
        musicUrl=""
        musicVolume={60}
        setIsMusicPlaying={() => {}}
        setMusicUrl={() => {}}
        setMusicVolume={() => {}}
        tts={buildTtsModel({ onSpeedChange, playbackRate: 2 })}
      />
    );

    expect(screen.getByRole('slider', { name: 'Velocita' })).toHaveAttribute(
      'aria-valuenow',
      '1.6'
    );
    expect(onSpeedChange).toHaveBeenCalledOnce();
    expect(onSpeedChange).toHaveBeenCalledWith(1.6);
  });

  test('adjusts the direct playback-speed dial with keyboard controls and respects its bounds', async () => {
    const user = userEvent.setup();
    const onSpeedChange = vi.fn();
    render(
      <UnifiedAudioPanel
        initialTab="voce"
        isOpen
        isMusicPlaying={false}
        musicUrl=""
        musicVolume={60}
        setIsMusicPlaying={() => {}}
        setMusicUrl={() => {}}
        setMusicVolume={() => {}}
        tts={buildTtsModel({ onSpeedChange })}
      />
    );

    const speedDial = screen.getByRole('slider', { name: 'Velocita' });
    speedDial.focus();
    await user.keyboard('{ArrowRight}{ArrowUp}{ArrowLeft}{End}{ArrowRight}{Home}{ArrowLeft}');

    expect(onSpeedChange.mock.calls.map(([speed]) => speed)).toEqual([1.05, 1.1, 1.05, 1.6, 0.8]);
  });

  test.each([
    'mouse',
    'touch',
  ] as const)('adjusts the playback-speed dial right and left with %s pointers', pointerType => {
    const onSpeedChange = vi.fn();
    render(
      <UnifiedAudioPanel
        initialTab="voce"
        isOpen
        isMusicPlaying={false}
        musicUrl=""
        musicVolume={60}
        setIsMusicPlaying={() => {}}
        setMusicUrl={() => {}}
        setMusicVolume={() => {}}
        tts={buildTtsModel({ onSpeedChange })}
      />
    );

    const speedDial = screen.getByRole('slider', { name: 'Velocita' });
    Object.assign(speedDial, {
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(speedDial, {
      clientX: 10,
      clientY: 20,
      pointerId: 7,
      pointerType,
    });
    fireEvent.pointerMove(speedDial, {
      clientX: 12,
      clientY: 20,
      pointerId: 7,
      pointerType,
    });
    expect(onSpeedChange).not.toHaveBeenCalled();

    fireEvent.pointerMove(speedDial, {
      clientX: 30,
      clientY: 20,
      pointerId: 7,
      pointerType,
    });
    fireEvent.pointerMove(speedDial, {
      clientX: 10,
      clientY: 20,
      pointerId: 7,
      pointerType,
    });
    fireEvent.pointerUp(speedDial, { pointerId: 7, pointerType });

    expect(onSpeedChange.mock.calls.map(([speed]) => speed)).toEqual([1.1, 1]);
  });

  test('keeps the iframe lazy until the user starts background audio', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AudioHarness initialMusicUrl="https://www.youtube.com/watch?v=8p7LwCBgpCE" />
    );

    expect(container.querySelector('#nous-bg-player')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Riproduci musica ambiente/i }));

    expect(container.querySelector('#nous-bg-player')).not.toBeNull();
  });

  test('derives invalid-url errors from the current input and clears them after a preset', async () => {
    const user = userEvent.setup();

    render(<AudioHarness initialMusicUrl="https://example.com/not-youtube" />);

    expect(screen.getByText(/Link non valido o video limitato da YouTube/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Riproduci musica ambiente/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Anti-anxiety/i }));

    expect(
      screen.queryByText(/Link non valido o video limitato da YouTube/i)
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Riproduci musica ambiente/i })).toBeEnabled();
  });

  test('accepts short youtu.be links as valid YouTube sources', () => {
    render(<AudioHarness initialMusicUrl="https://youtu.be/8p7LwCBgpCE" />);

    expect(
      screen.queryByText(/Link non valido o video limitato da YouTube/i)
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Riproduci musica ambiente/i })).toBeEnabled();
  });
});
