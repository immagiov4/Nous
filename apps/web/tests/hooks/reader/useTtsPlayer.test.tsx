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

const { useTtsPlayer } = await import('../../../hooks/reader/useTtsPlayer.ts');

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
    contentType: 'audio/wav',
  });
  openRouterMocks.getTTSModels.mockResolvedValue({
    defaultModel: 'google/gemini-3.8-flash-lite-tts',
    models: [
      {
        contextLength: 4096,
        id: 'google/gemini-3.8-flash-lite-tts',
        name: 'Google: Gemini 3.8 Flash Lite TTS',
        pricing: { completion: '0.000006', prompt: '0.0000005' },
        supportedParameters: ['response_format'],
        supportsVoiceCloning: false,
      },
    ],
  });
  openRouterMocks.getTTSVoices.mockResolvedValue([
    { id: 'Zephyr', label: 'Zephyr', language: 'it-IT' },
  ]);

  vi.stubGlobal('Audio', FakeAudio as unknown as typeof Audio);
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
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

describe('useTtsPlayer', () => {
  test('preserves authored paragraph order', () => {
    const markdown = 'Prima frase. Seconda frase.\n\nTerza frase finale.';
    const { result } = renderHook(() =>
      useTtsPlayer({
        projectId: 'project-1',
        activeSectionId: 'paragraphs',
        sectionContent: markdown,
      })
    );
    expect(result.current.chunkTexts).toEqual([
      'Prima frase. Seconda frase.',
      'Terza frase finale.',
    ]);
  });

  test('keeps visual-only source out of selectable speech chunks', () => {
    const markdown = [
      'Prima parte.',
      '{{PDF_IMAGE:pdf-img-001|alt=Schema sensibile|caption=Figura da saltare}}',
      '<figure><img src="x" alt="Alt da saltare" /><figcaption>Caption da saltare</figcaption></figure>',
      'Seconda parte.',
    ].join('\n\n');
    const { result } = renderHook(() =>
      useTtsPlayer({ projectId: 'project-1', activeSectionId: 'figures', sectionContent: markdown })
    );
    expect(result.current.chunkTexts).toEqual(['Prima parte.', 'Seconda parte.']);
  });

  test('loads TTS connectivity and available voices on mount', async () => {
    const { result } = renderHook(() =>
      useTtsPlayer({
        projectId: 'project-1',
        activeSectionId: 'lesson-1',
        sectionContent: 'Contenuto della lezione',
      })
    );

    await waitFor(() => expect(result.current.ttsConnected).toBe(true));

    expect(result.current.availableVoices).toEqual([
      { id: 'Zephyr', label: 'Zephyr', language: 'it-IT' },
    ]);
    expect(result.current.availableModels).toHaveLength(1);
  });

  test('polls TTS status without repeatedly fetching static voice metadata', async () => {
    vi.useFakeTimers();

    try {
      renderHook(() =>
        useTtsPlayer({
          projectId: 'project-1',
          activeSectionId: 'lesson-1',
          sectionContent: 'Contenuto della lezione',
        })
      );

      await vi.runOnlyPendingTimersAsync();
      expect(openRouterMocks.getTTSVoices).toHaveBeenCalledTimes(1);
      const statusCheckCountAfterInitialLoad = openRouterMocks.checkTTSStatus.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(openRouterMocks.checkTTSStatus.mock.calls.length).toBeGreaterThan(
        statusCheckCountAfterInitialLoad
      );
      expect(openRouterMocks.getTTSVoices).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('creates audio chunks, starts playback and updates playback rate', async () => {
    const { result } = renderHook(() =>
      useTtsPlayer({
        projectId: 'project-1',
        activeSectionId: 'lesson-1',
        sectionContent: 'Prima parte.\n\nSeconda parte.',
      })
    );

    await waitFor(() => expect(result.current.ttsConnected).toBe(true));

    act(() => {
      result.current.togglePlayPause();
    });

    await waitFor(() => expect(result.current.audioState.chunks.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.audioState.isPlaying).toBe(true));

    expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(2);
    expect(openRouterMocks.generateSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.any(String),
        voice: 'Zephyr',
        model: 'google/gemini-3.8-flash-lite-tts',
        block: expect.objectContaining({ speech: expect.any(String) }),
      })
    );
    expect(result.current.audioState.currentChunkIndex).toBe(0);

    const audioBlob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    expect(audioBlob.type).toBe('audio/wav');
    expect(audioBlob.size).toBe(480);

    act(() => {
      result.current.handleSpeedChange(1.25);
    });

    expect(result.current.audioState.playbackRate).toBe(1.25);
  });

  test('selects a speech chunk and starts it automatically', async () => {
    const sectionContent = `${'Prima parte della lezione con concetti introduttivi. '.repeat(16)}\n\n${'Seconda parte dedicata agli esempi applicativi. '.repeat(16)}`;
    const { result } = renderHook(() =>
      useTtsPlayer({
        projectId: 'project-1',
        activeSectionId: 'lesson-1',
        sectionContent,
      })
    );

    await waitFor(() => expect(result.current.ttsConnected).toBe(true));
    expect(result.current.chunkOptions.length).toBeGreaterThan(1);

    act(() => {
      result.current.handleSelectChunk(1);
    });

    expect(result.current.audioState.currentChunkIndex).toBe(1);
    expect(result.current.audioState.chunks).toHaveLength(result.current.chunkOptions.length);

    await waitFor(() => expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(1));
    expect(openRouterMocks.generateSpeech.mock.calls[0]?.[0].text).toBe(
      result.current.audioState.chunks[1]?.text
    );
  });

  test('falls back to disconnected state when the TTS checks fail', async () => {
    openRouterMocks.checkTTSStatus.mockRejectedValueOnce(new Error('offline'));
    openRouterMocks.getTTSModels.mockRejectedValueOnce(new Error('offline'));
    openRouterMocks.getTTSVoices.mockRejectedValueOnce(new Error('offline'));

    const { result } = renderHook(() =>
      useTtsPlayer({
        projectId: 'project-1',
        activeSectionId: 'lesson-1',
        sectionContent: 'Contenuto',
      })
    );

    await waitFor(() => expect(result.current.ttsConnected).toBe(false));
    expect(result.current.availableVoices).toEqual([
      { id: 'Zephyr', label: 'Zephyr', language: 'it-IT' },
    ]);
  });

  test('clears playback chunks when the active section changes', async () => {
    const { result, rerender } = renderHook(
      ({ activeSectionId, sectionContent }) =>
        useTtsPlayer({
          projectId: 'project-1',
          activeSectionId,
          sectionContent,
        }),
      {
        initialProps: {
          activeSectionId: 'lesson-1',
          sectionContent: 'Prima parte.\n\nSeconda parte.',
        },
      }
    );

    await waitFor(() => expect(result.current.ttsConnected).toBe(true));

    act(() => {
      result.current.togglePlayPause();
    });

    await waitFor(() => expect(result.current.audioState.chunks.length).toBeGreaterThan(0));

    rerender({
      activeSectionId: 'lesson-2',
      sectionContent: 'Nuova lezione',
    });

    await waitFor(() => {
      expect(result.current.audioState.chunks).toEqual([]);
      expect(result.current.audioState.isPlaying).toBe(false);
    });
  });

  test('stops the playback run after one retry instead of requesting every later chunk', async () => {
    vi.useFakeTimers();

    try {
      const upstreamError = Object.assign(new Error('temporary upstream failure'), { status: 502 });
      openRouterMocks.generateSpeech.mockRejectedValue(upstreamError);
      const sectionContent = `${'Prima parte abbastanza lunga. '.repeat(30)}\n\n${'Seconda parte abbastanza lunga. '.repeat(30)}`;
      const { result } = renderHook(() =>
        useTtsPlayer({
          projectId: 'project-1',
          activeSectionId: 'lesson-1',
          sectionContent,
        })
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => {
        result.current.togglePlayPause();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(result.current.chunkOptions.length).toBeGreaterThan(1);
      expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(2);
      expect(result.current.audioState.currentChunkIndex).toBe(0);
      expect(result.current.audioState.isPlaying).toBe(false);
      expect(result.current.errorMessage).toBe(
        'Non sono riuscito a generare l’audio. Riprova tra poco.'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

test('keeps selection text aligned with the rendered prose while sending original math for speech', async () => {
  const markdown = String.raw`Consideriamo $\mathcal{P}(A)$ e $f: A\to B$.`;
  const { result } = renderHook(() =>
    useTtsPlayer({ projectId: 'project-1', activeSectionId: 'math', sectionContent: markdown })
  );
  expect(result.current.chunkTexts).toEqual(['Consideriamo e .']);
  await waitFor(() => expect(result.current.ttsConnected).toBe(true));
  act(() => result.current.togglePlayPause());
  await waitFor(() => expect(openRouterMocks.generateSpeech).toHaveBeenCalled());
  expect(
    openRouterMocks.generateSpeech.mock.calls[0][0].block.spans.flatMap(
      (span: { math?: string }) => (span.math ? [span.math] : [])
    )
  ).toEqual([String.raw`$\mathcal{P}(A)$`, String.raw`$f: A\to B$`]);
});

test('projects rendered entities for text selection while retaining literal code entities', () => {
  const { result } = renderHook(() =>
    useTtsPlayer({
      projectId: 'project-1',
      activeSectionId: 'entities',
      sectionContent: 'Consideriamo A &amp; B e `$x &amp; y$`.',
    })
  );
  expect(result.current.chunkTexts).toEqual(['Consideriamo A & B e $x &amp; y$.']);
});

test.each([
  'La variabile foo_bar vale uno.',
  'Il costo è $5.',
  'Usa [x] come etichetta.',
  'A * B = C.',
])('keeps parser-recognized literal text selectable: %s', markdown => {
  const { result } = renderHook(() =>
    useTtsPlayer({ projectId: 'project-1', activeSectionId: 'literal', sectionContent: markdown })
  );
  expect(result.current.chunkTexts).toEqual([markdown]);
});
