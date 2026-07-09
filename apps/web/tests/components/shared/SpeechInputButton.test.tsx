// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const requestSpeechTranscriptionMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/openrouter/sttClient.ts', () => ({
  requestSpeechTranscription: requestSpeechTranscriptionMock,
}));

const { default: SpeechInputButton } = await import(
  '../../../components/shared/SpeechInputButton.tsx'
);

class FakeMediaRecorder {
  static isTypeSupported = vi.fn((mimeType: string) => mimeType.startsWith('audio/webm'));

  readonly mimeType: string;
  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || 'audio/webm';
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob(['recorded audio'], { type: this.mimeType }),
    } as BlobEvent);
    this.onstop?.();
  }
}

describe('SpeechInputButton', () => {
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn();

  beforeEach(() => {
    requestSpeechTranscriptionMock.mockReset();
    stopTrack.mockReset();
    getUserMedia.mockReset();
    getUserMedia.mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    });

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  });

  test('records on first click and transcribes on second click', async () => {
    const user = userEvent.setup();
    const onTranscription = vi.fn();
    requestSpeechTranscriptionMock.mockResolvedValue('Testo dettato.');

    render(
      <StrictMode>
        <SpeechInputButton onTranscription={onTranscription} />
      </StrictMode>
    );

    await user.click(screen.getByRole('button', { name: 'Avvia dettatura' }));

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(screen.getByRole('button', { name: 'Ferma e trascrivi' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await user.click(screen.getByRole('button', { name: 'Ferma e trascrivi' }));

    await waitFor(() => {
      expect(requestSpeechTranscriptionMock).toHaveBeenCalledWith(expect.any(Blob), 'webm', 'it');
      expect(onTranscription).toHaveBeenCalledWith('Testo dettato.');
    });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Avvia dettatura' })).toBeEnabled();
  });

  test('shows a useful error when microphone permission is denied', async () => {
    const user = userEvent.setup();
    getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));

    render(<SpeechInputButton onTranscription={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Avvia dettatura' }));

    expect(
      await screen.findByRole('alert', {
        name: 'Permesso microfono negato. Abilitalo nelle impostazioni del browser.',
      })
    ).toBeInTheDocument();
  });
});
