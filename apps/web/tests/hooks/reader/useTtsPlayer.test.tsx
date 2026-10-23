// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { TtsRequestError } from '../../../services/openrouter/ttsClient.ts';

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

test('keeps an unmatched code delimiter literal while decoding prose entities', () => {
  const { result } = renderHook(() =>
    useTtsPlayer({
      projectId: 'project-1',
      activeSectionId: 'literal-code-delimiter',
      sectionContent: 'Usa ` come simbolo, A &amp; B.',
    })
  );
  expect(result.current.chunkTexts).toEqual(['Usa ` come simbolo, A & B.']);
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

test('drops old recordings when the same section source changes, but preserves identical content', async () => {
  const initial = 'Prima parte.\n\nSeconda parte.';
  const { result, rerender } = renderHook(
    ({ markdown }) =>
      useTtsPlayer({
        projectId: 'project-1',
        activeSectionId: 'same-section',
        sectionContent: markdown,
        contentBlocks: [{ type: 'markdown', markdown }],
      }),
    { initialProps: { markdown: initial } }
  );
  await waitFor(() => expect(result.current.ttsConnected).toBe(true));
  act(() => result.current.togglePlayPause());
  await waitFor(() => expect(result.current.audioState.chunks[0]?.blobUrl).toBeTruthy());
  rerender({ markdown: initial });
  expect(result.current.audioState.chunks).toHaveLength(2);
  rerender({ markdown: 'Nuova formula $x=2$.' });
  await waitFor(() => expect(result.current.audioState.chunks).toHaveLength(0));
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  act(() => result.current.togglePlayPause());
  await waitFor(() =>
    expect(openRouterMocks.generateSpeech.mock.calls.at(-1)?.[0].text).toBe('Nuova formula $x=2$.')
  );
  const request = openRouterMocks.generateSpeech.mock.calls.at(-1)?.[0];
  expect(
    request.block.spans.flatMap((span: { math?: string }) => (span.math ? [span.math] : []))
  ).toEqual(['$x=2$']);
});

test('ignores an old source response after the next source starts with identical text', async () => {
  let release!: (audio: { audioBuffer: ArrayBuffer; contentType: string }) => void;
  openRouterMocks.generateSpeech.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  const { result, rerender } = renderHook(
    ({ projectId }) =>
      useTtsPlayer({
        projectId,
        activeSectionId: 'same-section',
        sectionContent: 'Stesso testo.',
      }),
    { initialProps: { projectId: 'first-project' } }
  );
  await waitFor(() => expect(result.current.ttsConnected).toBe(true));
  act(() => result.current.togglePlayPause());
  await waitFor(() => expect(openRouterMocks.generateSpeech).toHaveBeenCalledOnce());
  rerender({ projectId: 'next-project' });
  act(() => result.current.togglePlayPause());
  await waitFor(() => expect(result.current.audioState.chunks[0]?.blobUrl).toBeTruthy());
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  await act(async () => release({ audioBuffer: new ArrayBuffer(480), contentType: 'audio/wav' }));
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(result.current.audioState.chunks[0]?.blobUrl).toBe('blob:nous-audio');
  expect(result.current.audioState.isPlaying).toBe(true);
});

test('retains a valid pending recording when listening is paused and resumed', async () => {
  let release!: (audio: { audioBuffer: ArrayBuffer; contentType: string }) => void;
  openRouterMocks.generateSpeech.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  const { result } = renderHook(() =>
    useTtsPlayer({ projectId: 'project-1', activeSectionId: 'same', sectionContent: 'Una frase.' })
  );
  await waitFor(() => expect(result.current.ttsConnected).toBe(true));
  act(() => result.current.togglePlayPause());
  await waitFor(() => expect(openRouterMocks.generateSpeech).toHaveBeenCalledOnce());
  act(() => result.current.togglePlayPause());
  await act(async () => release({ audioBuffer: new ArrayBuffer(480), contentType: 'audio/wav' }));
  expect(result.current.audioState.chunks[0]?.blobUrl).toBeTruthy();
  expect(result.current.audioState.chunks[0]?.isLoading).toBe(false);
  act(() => result.current.togglePlayPause());
  await waitFor(() => expect(result.current.audioState.isPlaying).toBe(true));
  expect(openRouterMocks.generateSpeech).toHaveBeenCalledOnce();
});

test.each([
  'voice',
  'model',
] as const)('ignores an old prefetch failure after changing the %s', async setting => {
  let rejectOld!: (error: Error) => void;
  let releaseNew!: (audio: { audioBuffer: ArrayBuffer; contentType: string }) => void;
  openRouterMocks.generateSpeech
    .mockImplementationOnce(async () => ({
      audioBuffer: new ArrayBuffer(480),
      contentType: 'audio/wav',
    }))
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseNew = resolve;
        })
    );
  const { result } = renderHook(() =>
    useTtsPlayer({
      projectId: 'project-1',
      activeSectionId: 'same',
      sectionContent: 'Prima parte.\n\nSeconda parte.',
    })
  );
  await waitFor(() => expect(result.current.ttsConnected).toBe(true));
  act(() => result.current.togglePlayPause());
  await waitFor(() => expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(2));
  act(() => {
    if (setting === 'voice') result.current.handleVoiceChange('Kore');
    else result.current.handleModelChange('other/tts');
  });
  act(() => result.current.togglePlayPause());
  await waitFor(() => expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(3));
  await act(async () => rejectOld(new Error('Old request failed')));
  expect(result.current.errorMessage).toBeNull();
  await act(async () =>
    releaseNew({ audioBuffer: new ArrayBuffer(480), contentType: 'audio/wav' })
  );
  await waitFor(() => expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(4));
  expect(result.current.audioState.chunks[1]?.blobUrl).toBeTruthy();
  expect(result.current.audioState.isPlaying).toBe(true);
});

test('discards a pending recording after unmount', async () => {
  let release!: (audio: { audioBuffer: ArrayBuffer; contentType: string }) => void;
  openRouterMocks.generateSpeech.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      })
  );
  const { result, unmount } = renderHook(() =>
    useTtsPlayer({ projectId: 'project-1', activeSectionId: 'same', sectionContent: 'Una frase.' })
  );
  await waitFor(() => expect(result.current.ttsConnected).toBe(true));
  act(() => result.current.togglePlayPause());
  await waitFor(() => expect(openRouterMocks.generateSpeech).toHaveBeenCalledOnce());
  unmount();
  await act(async () => release({ audioBuffer: new ArrayBuffer(480), contentType: 'audio/wav' }));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test.each([
  12_000, 30_000, 45_000,
])('standard reader respects a %s ms provider hint and its cap', async retryAfterMs => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() =>
    useTtsPlayer({
      projectId: 'project-1',
      activeSectionId: 'retry',
      sectionContent: 'Synthetic narration.',
    })
  );
  try {
    openRouterMocks.generateSpeech.mockRejectedValue(
      new TtsRequestError('Speech unavailable.', 502, { retryAfterMs, maxRetryDelayMs: 30_000 })
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.togglePlayPause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(1);
    if (retryAfterMs > 30_000) {
      expect(result.current.errorMessage).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryAfterMs);
      });
      expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(1);
    } else {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(retryAfterMs - 1);
      });
      expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(2);
      expect(result.current.errorMessage).toBeTruthy();
    }
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

test.each([
  'pause',
  'seek',
  'unmount',
] as const)('standard reader cancels a provider retry wait on %s', async action => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() =>
    useTtsPlayer({
      projectId: 'project-1',
      activeSectionId: 'retry',
      sectionContent: 'First passage.\n\nSecond passage.',
    })
  );
  let mounted = true;
  try {
    openRouterMocks.generateSpeech.mockRejectedValueOnce(
      new TtsRequestError('Speech unavailable.', 502, {
        retryAfterMs: 30_000,
        maxRetryDelayMs: 30_000,
      })
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.togglePlayPause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(1);
    const firstText = openRouterMocks.generateSpeech.mock.calls[0][0].text;
    act(() => {
      if (action === 'pause') result.current.togglePlayPause();
      else if (action === 'seek') result.current.handleSelectChunk(1);
      else {
        unmount();
        mounted = false;
      }
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    if (mounted) {
      expect(result.current.audioState.chunks[0].isLoading).toBe(false);
      expect(result.current.errorMessage).toBeNull();
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(
      openRouterMocks.generateSpeech.mock.calls.filter(([request]) => request.text === firstText)
    ).toHaveLength(1);
  } finally {
    if (mounted) unmount();
    vi.useRealTimers();
  }
});

test.each([
  'pause',
  'seek',
] as const)('a late failed request cannot schedule a retry after %s', async action => {
  vi.useFakeTimers();
  let rejectSpeech!: (error: Error) => void;
  openRouterMocks.generateSpeech.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectSpeech = reject;
      })
  );
  const { result, unmount } = renderHook(() =>
    useTtsPlayer({
      projectId: 'project-1',
      activeSectionId: 'late-retry',
      sectionContent: 'First passage.\n\nSecond passage.',
    })
  );
  try {
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.togglePlayPause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const firstText = openRouterMocks.generateSpeech.mock.calls[0][0].text;
    act(() => {
      if (action === 'pause') result.current.togglePlayPause();
      else result.current.handleSelectChunk(1);
    });
    await act(async () => {
      rejectSpeech(
        new TtsRequestError('Speech unavailable.', 502, {
          retryAfterMs: 30_000,
          maxRetryDelayMs: 30_000,
        })
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.audioState.chunks[0].isLoading).toBe(false);
    expect(result.current.errorMessage).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(
      openRouterMocks.generateSpeech.mock.calls.filter(([request]) => request.text === firstText)
    ).toHaveLength(1);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

test.each([
  'resume',
  'prefetch',
] as const)('a new listening request can retry a reused pending %s recording', async action => {
  vi.useFakeTimers();
  let rejectSpeech!: (error: Error) => void;
  if (action === 'prefetch') {
    openRouterMocks.generateSpeech.mockResolvedValueOnce({
      audioBuffer: new ArrayBuffer(480),
      contentType: 'audio/wav',
    });
  }
  openRouterMocks.generateSpeech.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectSpeech = reject;
      })
  );
  const { result, unmount } = renderHook(() =>
    useTtsPlayer({
      projectId: 'project-1',
      activeSectionId: 'reuse-retry',
      sectionContent: action === 'prefetch' ? 'First passage.\n\nSecond passage.' : 'Only passage.',
    })
  );
  try {
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.togglePlayPause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initialRequests = action === 'prefetch' ? 2 : 1;
    expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(initialRequests);
    if (action === 'prefetch') {
      act(() => result.current.handleSelectChunk(1));
    } else {
      act(() => result.current.togglePlayPause());
      act(() => result.current.togglePlayPause());
    }
    await act(async () => {
      rejectSpeech(
        new TtsRequestError('Speech unavailable.', 502, {
          retryAfterMs: 12_000,
          maxRetryDelayMs: 30_000,
        })
      );
      await vi.advanceTimersByTimeAsync(11_999);
    });
    expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(initialRequests);
    expect(result.current.errorMessage).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(initialRequests + 1);
    expect(result.current.audioState.isPlaying).toBe(true);
    expect(result.current.audioState.chunks[action === 'prefetch' ? 1 : 0].isLoading).toBe(false);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

test.each([
  45_000, 750,
])('Play retries explicitly after a %s ms provider failure', async retryAfterMs => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() =>
    useTtsPlayer({
      projectId: 'project-1',
      activeSectionId: 'retry-play',
      sectionContent: 'One passage.',
    })
  );
  try {
    openRouterMocks.generateSpeech.mockRejectedValue(
      new TtsRequestError('Speech unavailable.', 502, { retryAfterMs, maxRetryDelayMs: 30_000 })
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.togglePlayPause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(result.current.errorMessage).toBeTruthy();
    expect(result.current.audioState.isPlaying).toBe(false);
    const failedRequests = openRouterMocks.generateSpeech.mock.calls.length;
    openRouterMocks.generateSpeech.mockResolvedValue({
      audioBuffer: new ArrayBuffer(480),
      contentType: 'audio/wav',
    });
    act(() => result.current.togglePlayPause());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(openRouterMocks.generateSpeech).toHaveBeenCalledTimes(failedRequests + 1);
    expect(result.current.audioState.isPlaying).toBe(true);
    expect(result.current.errorMessage).toBeNull();
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
