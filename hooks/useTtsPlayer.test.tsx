// @vitest-environment jsdom
import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const geminiMocks = vi.hoisted(() => ({
  checkTTSStatus: vi.fn(),
  generateSpeech: vi.fn(),
  getTTSVoices: vi.fn(),
}));

vi.mock('../services/geminiService', () => ({
  checkTTSStatus: geminiMocks.checkTTSStatus,
  generateSpeech: geminiMocks.generateSpeech,
  getTTSVoices: geminiMocks.getTTSVoices,
}));

const { splitContentIntoChunks, splitOversizedText, useTtsPlayer } = await import('./useTtsPlayer.ts');

class FakeAudio {
  currentTime = 0;
  duration = 6;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = true;
  playbackRate = 1;
  src: string;
  volume = 1;

  constructor(src = '') {
    this.src = src;
  }

  load() {}

  pause() {
    this.paused = true;
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }
}

describe('useTtsPlayer', () => {
  beforeEach(() => {
    geminiMocks.checkTTSStatus.mockReset();
    geminiMocks.generateSpeech.mockReset();
    geminiMocks.getTTSVoices.mockReset();

    geminiMocks.checkTTSStatus.mockResolvedValue({
      isReady: true,
      isRunning: true,
    });
    geminiMocks.generateSpeech.mockResolvedValue(new ArrayBuffer(480));
    geminiMocks.getTTSVoices.mockResolvedValue([
      { id: 'mario', label: 'Mario', language: 'it-IT' },
    ]);

    vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
    window.Audio = FakeAudio as unknown as typeof Audio;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:lumina-audio'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  test('splits oversized text and groups speech blocks predictably', () => {
    expect(splitOversizedText('alfa beta gamma delta', 9)).toEqual([
      'alfa beta',
      'gamma',
      'delta',
    ]);

    const chunks = splitContentIntoChunks('', [
      'Prima frase. Seconda frase con abbastanza testo da restare nello stesso blocco.',
      'Terza frase finale.',
    ]);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join(' ')).toContain('Prima frase.');
    expect(chunks.join(' ')).toContain('Terza frase finale.');
  });

  test('loads TTS connectivity and available voices on mount', async () => {
    const { result } = renderHook(() =>
      useTtsPlayer({
        activeSectionId: 'lesson-1',
        sectionContent: 'Contenuto della lezione',
        speechBlocks: [],
      })
    );

    await waitFor(() => expect(result.current.ttsConnected).toBe(true));

    expect(result.current.availableVoices).toEqual([
      { id: 'mario', label: 'Mario', language: 'it-IT' },
    ]);
  });

  test('creates audio chunks, starts playback and updates playback rate', async () => {
    const { result } = renderHook(() =>
      useTtsPlayer({
        activeSectionId: 'lesson-1',
        sectionContent: 'Prima parte.\n\nSeconda parte.',
        speechBlocks: [],
      })
    );

    await waitFor(() => expect(result.current.ttsConnected).toBe(true));

    act(() => {
      result.current.togglePlayPause();
    });

    await waitFor(() => expect(result.current.audioState.chunks.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.audioState.isPlaying).toBe(true));

    expect(geminiMocks.generateSpeech).toHaveBeenCalledTimes(1);
    expect(result.current.audioState.currentChunkIndex).toBe(0);

    act(() => {
      result.current.handleSpeedChange(1.25);
    });

    expect(result.current.audioState.playbackRate).toBe(1.25);
  });

  test('falls back to disconnected state when the TTS checks fail', async () => {
    geminiMocks.checkTTSStatus.mockRejectedValueOnce(new Error('offline'));
    geminiMocks.getTTSVoices.mockRejectedValueOnce(new Error('offline'));

    const { result } = renderHook(() =>
      useTtsPlayer({
        activeSectionId: 'lesson-1',
        sectionContent: 'Contenuto',
        speechBlocks: [],
      })
    );

    await waitFor(() => expect(result.current.ttsConnected).toBe(false));
    expect(result.current.availableVoices).toEqual([
      { id: 'mario', label: 'Mario', language: 'it-IT' },
    ]);
  });
});
