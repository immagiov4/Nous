// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
    Object.defineProperty(globalThis, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  test('keeps failed audio available for an explicit transcription retry', async () => {
    const user = userEvent.setup();
    const onTranscription = vi.fn();
    requestSpeechTranscriptionMock
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('Testo recuperato.');

    render(<SpeechInputButton onTranscription={onTranscription} />);

    await user.click(screen.getByRole('button', { name: 'Avvia dettatura' }));
    await user.click(screen.getByRole('button', { name: 'Ferma e trascrivi' }));

    expect(
      await screen.findByRole('alert', {
        name: 'Trascrizione non riuscita. Puoi riprovare senza registrare di nuovo.',
      })
    ).toBeInTheDocument();

    const firstAudio = requestSpeechTranscriptionMock.mock.calls[0]?.[0];
    await user.click(screen.getByRole('button', { name: 'Riprova trascrizione' }));

    await waitFor(() => {
      expect(requestSpeechTranscriptionMock).toHaveBeenCalledTimes(2);
      expect(requestSpeechTranscriptionMock.mock.calls[1]?.[0]).toBe(firstAudio);
      expect(onTranscription).toHaveBeenCalledWith('Testo recuperato.');
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  test('lets the user dismiss an error and replaces it on the next attempt', async () => {
    const user = userEvent.setup();
    getUserMedia
      .mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
      .mockRejectedValueOnce(new DOMException('Missing', 'NotFoundError'));

    render(<SpeechInputButton onTranscription={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Avvia dettatura' }));
    await user.click(screen.getByRole('button', { name: 'Chiudi avviso microfono' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Avvia dettatura' }));
    expect(
      await screen.findByRole('alert', { name: 'Nessun microfono disponibile.' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  test('automatically clears a temporary acquisition error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    getUserMedia.mockRejectedValue(new DOMException('Device temporarily busy', 'NotReadableError'));

    render(<SpeechInputButton onTranscription={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Avvia dettatura' }));
    expect(
      await screen.findByRole('alert', {
        name: 'Il microfono è occupato o non è temporaneamente disponibile. Riprova.',
      })
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('explains when microphone capture is blocked by an insecure page', async () => {
    const user = userEvent.setup();
    Object.defineProperty(globalThis, 'isSecureContext', {
      configurable: true,
      value: false,
    });

    render(<SpeechInputButton onTranscription={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Avvia dettatura' }));

    expect(
      screen.getByRole('alert', {
        name: 'Il microfono richiede una connessione sicura (HTTPS o localhost).',
      })
    ).toBeInTheDocument();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
