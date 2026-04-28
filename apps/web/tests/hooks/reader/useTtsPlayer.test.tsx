// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const openRouterMocks = vi.hoisted(() => ({
  checkTTSStatus: vi.fn(),
  generateSpeech: vi.fn(),
  getTTSModels: vi.fn(),
  getTTSVoices: vi.fn(),
}));

vi.mock('../../../services/openrouter', () => ({
  checkTTSStatus: openRouterMocks.checkTTSStatus,
  generateSpeech: openRouterMocks.generateSpeech,
  getTTSModels: openRouterMocks.getTTSModels,
  getTTSVoices: openRouterMocks.getTTSVoices,
}));

const { splitContentIntoChunks, splitOversizedText, useTtsPlayer } = await import(
  '../../../hooks/reader/useTtsPlayer.ts'
);

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
    openRouterMocks.checkTTSStatus.mockReset();
    openRouterMocks.generateSpeech.mockReset();
    openRouterMocks.getTTSModels.mockReset();
    openRouterMocks.getTTSVoices.mockReset();

    openRouterMocks.checkTTSStatus.mockResolvedValue({
      isReady: true,
      isRunning: true,
    });
    openRouterMocks.generateSpeech.mockResolvedValue({
      audioBuffer: new ArrayBuffer(480),
      contentType: 'audio/mpeg',
    });
    openRouterMocks.getTTSModels.mockResolvedValue({
      defaultModel: 'openai/gpt-4o-mini-tts-2025-12-15',
      models: [
        {
          contextLength: 4096,
          id: 'openai/gpt-4o-mini-tts-2025-12-15',
          name: 'OpenAI: GPT-4o Mini TTS',
          pricing: { completion: '0', prompt: '0.0000006' },
          supportedParameters: ['response_format'],
          supportsVoiceCloning: false,
        },
      ],
    });
    openRouterMocks.getTTSVoices.mockResolvedValue([
      { id: 'coral', label: 'coral', language: 'it-IT' },
    ]);

    vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
    window.Audio = FakeAudio as unknown as typeof Audio;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:nous-audio'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  test('splits oversized text and groups speech blocks predictably', () => {
    expect(splitOversizedText('alfa beta gamma delta', 9)).toEqual(['alfa beta', 'gamma', 'delta']);

    const chunks = splitContentIntoChunks('', [
      'Prima frase. Seconda frase con abbastanza testo da restare nello stesso blocco.',
      'Terza frase finale.',
    ]);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join(' ')).toContain('Prima frase.');
    expect(chunks.join(' ')).toContain('Terza frase finale.');
  });

  test('removes image placeholders and figure markup from fallback speech chunks', () => {
    const chunks = splitContentIntoChunks(
      [
        'Prima parte.',
        '{{PDF_IMAGE:pdf-img-001|alt=Schema sensibile|caption=Figura da saltare}}',
        '<figure><img src="x" alt="Alt da saltare" /><figcaption>Caption da saltare</figcaption></figure>',
        'Seconda parte.',
      ].join('\n\n'),
      []
    );

    const spokenText = chunks.join(' ');
    expect(spokenText).toContain('Prima parte.');
    expect(spokenText).toContain('Seconda parte.');
    expect(spokenText).not.toContain('PDF_IMAGE');
    expect(spokenText).not.toContain('Schema sensibile');
    expect(spokenText).not.toContain('Caption da saltare');
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
      { id: 'coral', label: 'coral', language: 'it-IT' },
    ]);
    expect(result.current.availableModels).toHaveLength(1);
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

    expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(1);
    expect(openRouterMocks.generateSpeech).toHaveBeenCalledWith(
      expect.any(String),
      'coral',
      'openai/gpt-4o-mini-tts-2025-12-15'
    );
    expect(result.current.audioState.currentChunkIndex).toBe(0);

    act(() => {
      result.current.handleSpeedChange(1.25);
    });

    expect(result.current.audioState.playbackRate).toBe(1.25);
  });

  test('falls back to disconnected state when the TTS checks fail', async () => {
    openRouterMocks.checkTTSStatus.mockRejectedValueOnce(new Error('offline'));
    openRouterMocks.getTTSModels.mockRejectedValueOnce(new Error('offline'));
    openRouterMocks.getTTSVoices.mockRejectedValueOnce(new Error('offline'));

    const { result } = renderHook(() =>
      useTtsPlayer({
        activeSectionId: 'lesson-1',
        sectionContent: 'Contenuto',
        speechBlocks: [],
      })
    );

    await waitFor(() => expect(result.current.ttsConnected).toBe(false));
    expect(result.current.availableVoices).toEqual([
      { id: 'coral', label: 'coral', language: 'it-IT' },
    ]);
  });
});
