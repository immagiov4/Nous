// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import type { WorkspaceReaderTtsModel } from '../../../components/workspace/shell/types.ts';
import UnifiedAudioPanel from '../../../components/workspace/UnifiedAudioPanel.tsx';

const buildTtsModel = (): WorkspaceReaderTtsModel => ({
  availableVoices: [{ id: 'alloy', label: 'Alloy', language: 'en' }],
  currentTime: 0,
  currentVoice: 'alloy',
  duration: 180,
  isLoading: false,
  isPlaying: false,
  onPlayPause: () => {},
  onSeek: () => {},
  onSkipChunk: () => {},
  onSpeedChange: () => {},
  onVoiceChange: () => {},
  playbackRate: 1,
  sectionContent: 'Contenuto di test',
  ttsConnected: true,
});

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
