import { useCallback, useEffect, useRef, useState } from 'react';
import { createWavBlob } from '../../services/audio/ttsAudio';
import * as OpenRouterService from '../../services/openrouter';
import type { AudioChunk, AudioState, VoiceProfileId } from '../../types';
import { prepareMarkdownForSpeech } from '../../utils/reader/readingText';

const CHUNK_SIZE_APPROX = 580;
const CHUNK_CROSSFADE_SECONDS = 0.035;
const DEBUG_TTS_PLAYER = false;

interface UseTtsPlayerParams {
  activeSectionId: string | null;
  sectionContent: string;
  speechBlocks: string[];
}

interface UseTtsPlayerResult {
  availableVoices: Array<{ id: VoiceProfileId; label: string; language: string }>;
  audioState: AudioState;
  handleSeek: (time: number) => void;
  handleSkipChunk: (direction: 'prev' | 'next') => void;
  handleSpeedChange: (speed: number) => void;
  handleVoiceChange: (voice: VoiceProfileId) => void;
  playerCurrentTime: number;
  playerDuration: number;
  stopAudio: (clearChunks?: boolean) => void;
  togglePlayPause: () => void;
  ttsConnected: boolean;
}

type PlaybackStatus = 'idle' | 'starting' | 'playing' | 'crossfading' | 'paused' | 'stopping';

interface PlaybackRun {
  runId: number;
  status: PlaybackStatus;
  currentChunkIndex: number;
  currentAudio: HTMLAudioElement | null;
  pendingAudio: HTMLAudioElement | null;
  crossfadeIntervalId: number | null;
  cancelled: boolean;
}

export const splitOversizedText = (text: string, maxLength: number): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }

  const clauseParts = text.split(/(?<=[,;:])\s+/);
  if (clauseParts.length > 1) {
    return clauseParts.flatMap(part => splitOversizedText(part.trim(), maxLength));
  }

  const wordParts = text.split(/\s+/);
  if (wordParts.length > 1) {
    const segments: string[] = [];
    let currentSegment = '';

    wordParts.forEach(word => {
      const candidate = currentSegment ? `${currentSegment} ${word}` : word;
      if (candidate.length <= maxLength) {
        currentSegment = candidate;
        return;
      }

      if (currentSegment) {
        segments.push(currentSegment);
      }

      if (word.length <= maxLength) {
        currentSegment = word;
        return;
      }

      for (let index = 0; index < word.length; index += maxLength) {
        segments.push(word.slice(index, index + maxLength));
      }
      currentSegment = '';
    });

    if (currentSegment) {
      segments.push(currentSegment);
    }

    return segments;
  }

  const segments: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    segments.push(text.slice(index, index + maxLength));
  }
  return segments;
};

export const splitContentIntoChunks = (text: string, speechBlocks: string[]): string[] => {
  const normalizedBlocks = speechBlocks
    .map(block => block.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (normalizedBlocks.length > 0) {
    const chunks: string[] = [];
    let currentChunk = '';

    const flushChunk = () => {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
    };

    const appendUnit = (unit: string, separator = '\n\n') => {
      if (!unit) {
        return;
      }

      if (!currentChunk) {
        currentChunk = unit;
        return;
      }

      if (currentChunk.length + separator.length + unit.length > CHUNK_SIZE_APPROX) {
        flushChunk();
        currentChunk = unit;
        return;
      }

      currentChunk += `${separator}${unit}`;
    };

    const appendBoundedUnit = (unit: string, separator = '\n\n') => {
      splitOversizedText(unit, CHUNK_SIZE_APPROX).forEach((part, index) => {
        appendUnit(part.trim(), index === 0 ? separator : ' ');
      });
    };

    normalizedBlocks.forEach(block => {
      if (block.length <= CHUNK_SIZE_APPROX) {
        appendUnit(block);
        return;
      }

      const sentences = block.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [block];
      sentences.forEach(sentence => {
        appendBoundedUnit(sentence.trim(), ' ');
      });
    });

    flushChunk();
    return chunks;
  }

  const cleanText = prepareMarkdownForSpeech(text);
  const paragraphs = cleanText.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  const pushCurrentChunk = () => {
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
  };

  const appendParagraphPart = (part: string, separator = '\n\n') => {
    if (!part) {
      return;
    }

    if (!currentChunk) {
      currentChunk = part;
      return;
    }

    if (currentChunk.length + separator.length + part.length > CHUNK_SIZE_APPROX) {
      pushCurrentChunk();
      currentChunk = part;
      return;
    }

    currentChunk += `${separator}${part}`;
  };

  paragraphs.forEach(paragraph => {
    if (paragraph.length > CHUNK_SIZE_APPROX) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+(\s|$)/g) || [paragraph];
      sentences.forEach(sentence => {
        splitOversizedText(sentence.trim(), CHUNK_SIZE_APPROX).forEach(part => {
          appendParagraphPart(part, ' ');
        });
      });
      return;
    }

    if (currentChunk.length + paragraph.length > CHUNK_SIZE_APPROX) {
      pushCurrentChunk();
      currentChunk = paragraph;
    } else {
      currentChunk += `${currentChunk ? '\n\n' : ''}${paragraph}`;
    }
  });

  pushCurrentChunk();

  return chunks;
};

const createIdlePlaybackRun = (): PlaybackRun => ({
  runId: 0,
  status: 'idle',
  currentChunkIndex: 0,
  currentAudio: null,
  pendingAudio: null,
  crossfadeIntervalId: null,
  cancelled: false,
});

export const useTtsPlayer = ({
  activeSectionId,
  sectionContent,
  speechBlocks,
}: UseTtsPlayerParams): UseTtsPlayerResult => {
  const [availableVoices, setAvailableVoices] = useState<
    Array<{ id: VoiceProfileId; label: string; language: string }>
  >([{ id: 'mario', label: 'Mario', language: 'it-IT' }]);
  const [audioState, setAudioState] = useState<AudioState>({
    isPlaying: false,
    currentVoice: 'mario',
    playbackRate: 1,
    chunks: [],
    currentChunkIndex: 0,
    audioElement: null,
  });
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [ttsConnected, setTtsConnected] = useState(false);

  const audioStateRef = useRef(audioState);
  const shouldPlayRef = useRef(false);
  const chunkPromisesRef = useRef<Record<number, Promise<string | null>>>({});
  const playbackSessionRef = useRef(0);
  const playbackRunIdRef = useRef(0);
  const playRequestIdRef = useRef(0);
  const generatedObjectUrlsRef = useRef<Set<string>>(new Set());
  const ttsCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playbackRunRef = useRef<PlaybackRun>(createIdlePlaybackRun());
  const pausedTimeRef = useRef(0);

  const logPlayback = useCallback((event: string, details: Record<string, unknown> = {}) => {
    if (!DEBUG_TTS_PLAYER) {
      return;
    }

    console.log('[tts-player]', event, details);
  }, []);

  const setTrackedAudioState = useCallback(
    (updater: AudioState | ((previousState: AudioState) => AudioState)) => {
      const nextState =
        typeof updater === 'function'
          ? (updater as (previousState: AudioState) => AudioState)(audioStateRef.current)
          : updater;

      audioStateRef.current = nextState;
      setAudioState(nextState);
    },
    []
  );

  const syncReactAudioStateFromRun = useCallback(
    (run: PlaybackRun) => {
      const isPlaying = run.status === 'playing' || run.status === 'crossfading';
      setTrackedAudioState(previousState => ({
        ...previousState,
        isPlaying,
        currentChunkIndex: run.currentChunkIndex,
        audioElement: run.currentAudio,
      }));
    },
    [setTrackedAudioState]
  );

  const revokeTrackedUrl = useCallback((url: string | null | undefined) => {
    if (!url) {
      return;
    }

    if (generatedObjectUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      generatedObjectUrlsRef.current.delete(url);
    }
  }, []);

  const disposeAudioElement = useCallback((audio: HTMLAudioElement | null) => {
    if (!audio) {
      return;
    }

    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.src = '';
    audio.load();
  }, []);

  const stopAndDisposeAudio = useCallback(
    (audio: HTMLAudioElement | null, label: 'current' | 'pending') => {
      if (!audio) {
        return;
      }

      logPlayback(`dispose ${label}`, {
        runId: playbackRunRef.current.runId,
        status: playbackRunRef.current.status,
        chunkIndex: playbackRunRef.current.currentChunkIndex,
      });
      disposeAudioElement(audio);
    },
    [disposeAudioElement, logPlayback]
  );

  const clearCrossfadeInterval = useCallback((run: PlaybackRun) => {
    if (run.crossfadeIntervalId !== null) {
      window.clearInterval(run.crossfadeIntervalId);
      run.crossfadeIntervalId = null;
    }
  }, []);

  const abortCurrentRun = useCallback(
    (reason: 'stop' | 'pause' | 'skip' | 'replace' | 'ended' | 'error' | 'unmount') => {
      const run = playbackRunRef.current;
      if (run.runId === 0 && !run.currentAudio && !run.pendingAudio) {
        return;
      }

      logPlayback('abort', {
        reason,
        runId: run.runId,
        status: run.status,
        chunkIndex: run.currentChunkIndex,
      });

      if (reason === 'pause') {
        pausedTimeRef.current = run.currentAudio?.currentTime ?? pausedTimeRef.current;
        setPlayerCurrentTime(pausedTimeRef.current);
      } else {
        pausedTimeRef.current = 0;
      }

      run.cancelled = true;
      run.status = 'stopping';
      clearCrossfadeInterval(run);
      stopAndDisposeAudio(run.pendingAudio, 'pending');
      stopAndDisposeAudio(run.currentAudio, 'current');
      run.pendingAudio = null;
      run.currentAudio = null;
      run.status = reason === 'pause' ? 'paused' : 'idle';
      syncReactAudioStateFromRun(run);
    },
    [clearCrossfadeInterval, logPlayback, stopAndDisposeAudio, syncReactAudioStateFromRun]
  );

  const beginNewRun = useCallback(
    (startChunkIndex: number) => {
      playbackSessionRef.current += 1;
      playbackRunIdRef.current += 1;

      const run: PlaybackRun = {
        runId: playbackRunIdRef.current,
        status: 'starting',
        currentChunkIndex: startChunkIndex,
        currentAudio: null,
        pendingAudio: null,
        crossfadeIntervalId: null,
        cancelled: false,
      };

      playbackRunRef.current = run;
      logPlayback('run start', {
        runId: run.runId,
        status: run.status,
        chunkIndex: run.currentChunkIndex,
      });
      syncReactAudioStateFromRun(run);
      return run;
    },
    [logPlayback, syncReactAudioStateFromRun]
  );

  const registerCurrentAudio = useCallback(
    (audio: HTMLAudioElement, chunkIndex: number, runId: number) => {
      const run = playbackRunRef.current;
      if (run.runId !== runId || run.cancelled) {
        stopAndDisposeAudio(audio, 'current');
        return false;
      }

      if (run.currentAudio && run.currentAudio !== audio) {
        stopAndDisposeAudio(run.currentAudio, 'current');
      }

      run.currentAudio = audio;
      run.currentChunkIndex = chunkIndex;
      run.status = 'starting';
      logPlayback('current registered', {
        runId,
        status: run.status,
        chunkIndex,
      });
      syncReactAudioStateFromRun(run);
      return true;
    },
    [logPlayback, stopAndDisposeAudio, syncReactAudioStateFromRun]
  );

  const registerPendingAudio = useCallback(
    (audio: HTMLAudioElement, runId: number) => {
      const run = playbackRunRef.current;
      if (run.runId !== runId || run.cancelled) {
        stopAndDisposeAudio(audio, 'pending');
        return false;
      }

      if (run.pendingAudio && run.pendingAudio !== audio) {
        stopAndDisposeAudio(run.pendingAudio, 'pending');
      }

      run.pendingAudio = audio;
      run.status = 'crossfading';
      logPlayback('pending registered', {
        runId,
        status: run.status,
        chunkIndex: run.currentChunkIndex,
      });
      syncReactAudioStateFromRun(run);
      return true;
    },
    [logPlayback, stopAndDisposeAudio, syncReactAudioStateFromRun]
  );

  const promotePendingAudio = useCallback(
    (runId: number, nextChunkIndex: number) => {
      const run = playbackRunRef.current;
      if (run.runId !== runId || run.cancelled || !run.pendingAudio) {
        return false;
      }

      run.currentAudio = run.pendingAudio;
      run.pendingAudio = null;
      run.currentChunkIndex = nextChunkIndex;
      run.status = 'playing';
      pausedTimeRef.current = 0;
      logPlayback('promote pending', {
        runId,
        status: run.status,
        chunkIndex: nextChunkIndex,
      });
      syncReactAudioStateFromRun(run);
      return true;
    },
    [logPlayback, syncReactAudioStateFromRun]
  );

  const generateChunkAudio = useCallback(
    async (index: number, retries = 2): Promise<string | null> => {
      if (audioStateRef.current.chunks[index]?.blobUrl) {
        return audioStateRef.current.chunks[index].blobUrl;
      }

      if (chunkPromisesRef.current[index]) {
        return chunkPromisesRef.current[index];
      }

      const promise = (async () => {
        setTrackedAudioState(previousState => {
          const nextChunks = [...previousState.chunks];
          if (nextChunks[index]) {
            nextChunks[index] = { ...nextChunks[index], isLoading: true };
          }

          return { ...previousState, chunks: nextChunks };
        });

        try {
          const chunk = audioStateRef.current.chunks[index];
          const requestedVoice = audioStateRef.current.currentVoice;
          if (!chunk) {
            throw new Error('Chunk not found');
          }

          const requestedText = chunk.text;
          const pcmBuffer = await OpenRouterService.generateSpeech(requestedText, requestedVoice);
          const wavBlob = createWavBlob(pcmBuffer);
          const url = URL.createObjectURL(wavBlob);
          generatedObjectUrlsRef.current.add(url);

          const latestChunk = audioStateRef.current.chunks[index];
          if (
            !latestChunk ||
            latestChunk.text !== requestedText ||
            audioStateRef.current.currentVoice !== requestedVoice
          ) {
            revokeTrackedUrl(url);
            delete chunkPromisesRef.current[index];
            return null;
          }

          const previousUrl = latestChunk.blobUrl;
          if (previousUrl && previousUrl !== url) {
            revokeTrackedUrl(previousUrl);
          }

          setTrackedAudioState(previousState => {
            const nextChunks = [...previousState.chunks];
            if (nextChunks[index]) {
              nextChunks[index] = { ...nextChunks[index], blobUrl: url, isLoading: false };
            }

            return { ...previousState, chunks: nextChunks };
          });

          delete chunkPromisesRef.current[index];
          return url;
        } catch (error) {
          console.error(`Error generating chunk ${index}`, error);

          if (retries > 0) {
            delete chunkPromisesRef.current[index];
            await new Promise(resolve => setTimeout(resolve, 1000));
            return generateChunkAudio(index, retries - 1);
          }

          setTrackedAudioState(previousState => {
            const nextChunks = [...previousState.chunks];
            if (nextChunks[index]) {
              nextChunks[index] = { ...nextChunks[index], isLoading: false };
            }

            return { ...previousState, chunks: nextChunks };
          });

          delete chunkPromisesRef.current[index];
          return null;
        }
      })();

      chunkPromisesRef.current[index] = promise;
      return promise;
    },
    [revokeTrackedUrl, setTrackedAudioState]
  );

  const playAudioRef = useRef<(startIndex?: number, startTime?: number) => Promise<void>>(
    async () => {}
  );

  const handleChunkEnded = useCallback(
    (chunkIndex: number, requestId: number, sessionId: number, runId: number) => {
      const run = playbackRunRef.current;
      if (
        requestId !== playRequestIdRef.current ||
        sessionId !== playbackSessionRef.current ||
        runId !== run.runId ||
        run.cancelled
      ) {
        return;
      }

      const followingIndex = chunkIndex + 1;
      if (followingIndex < audioStateRef.current.chunks.length) {
        if (shouldPlayRef.current) {
          void playAudioRef.current(followingIndex, 0);
        }
        return;
      }

      pausedTimeRef.current = 0;
      abortCurrentRun('ended');
      setTrackedAudioState(previousState => ({
        ...previousState,
        isPlaying: false,
        currentChunkIndex: 0,
        audioElement: null,
      }));
      setPlayerCurrentTime(0);
      setPlayerDuration(0);
      shouldPlayRef.current = false;
      playbackRunRef.current.currentChunkIndex = 0;
    },
    [abortCurrentRun, setTrackedAudioState]
  );

  const attachAudioLifecycle = useCallback(
    (
      audio: HTMLAudioElement,
      chunkIndex: number,
      requestId: number,
      sessionId: number,
      runId: number
    ) => {
      audio.onended = () => {
        const run = playbackRunRef.current;
        if (run.runId === runId && run.status === 'crossfading' && run.currentAudio === audio) {
          return;
        }

        handleChunkEnded(chunkIndex, requestId, sessionId, runId);
      };

      audio.onerror = () => {
        const run = playbackRunRef.current;
        if (
          requestId !== playRequestIdRef.current ||
          sessionId !== playbackSessionRef.current ||
          runId !== run.runId ||
          run.cancelled
        ) {
          return;
        }

        shouldPlayRef.current = false;
        abortCurrentRun('error');
        setTrackedAudioState(previousState => ({
          ...previousState,
          isPlaying: false,
          audioElement: null,
        }));
      };
    },
    [abortCurrentRun, handleChunkEnded, setTrackedAudioState]
  );

  const playAudio = useCallback(
    async (startIndex = 0, startTime = 0): Promise<void> => {
      const run = playbackRunRef.current;
      if (run.runId === 0 || run.cancelled) {
        return;
      }

      const requestId = ++playRequestIdRef.current;
      const sessionId = playbackSessionRef.current;
      const runId = run.runId;
      const chunk = audioStateRef.current.chunks[startIndex];
      if (!chunk) {
        return;
      }

      let url = chunk.blobUrl;
      if (!url) {
        url = await generateChunkAudio(startIndex);
        if (
          !shouldPlayRef.current ||
          requestId !== playRequestIdRef.current ||
          sessionId !== playbackSessionRef.current ||
          runId !== playbackRunRef.current.runId ||
          playbackRunRef.current.cancelled ||
          !url
        ) {
          return;
        }
      }

      if (
        !shouldPlayRef.current ||
        requestId !== playRequestIdRef.current ||
        sessionId !== playbackSessionRef.current ||
        runId !== playbackRunRef.current.runId ||
        playbackRunRef.current.cancelled
      ) {
        return;
      }

      const audio = new Audio(url);
      audio.playbackRate = audioStateRef.current.playbackRate;
      audio.volume = 1;

      if (!registerCurrentAudio(audio, startIndex, runId)) {
        return;
      }

      attachAudioLifecycle(audio, startIndex, requestId, sessionId, runId);

      if (startTime > 0) {
        try {
          audio.currentTime = startTime;
        } catch (error) {
          console.error('Resume seek failed', error);
        }
      }

      const nextIndex = startIndex + 1;
      if (nextIndex < audioStateRef.current.chunks.length) {
        void generateChunkAudio(nextIndex);
      }

      try {
        await audio.play();
      } catch (error) {
        console.error('Play failed', error);
        if (
          requestId === playRequestIdRef.current &&
          sessionId === playbackSessionRef.current &&
          runId === playbackRunRef.current.runId &&
          !playbackRunRef.current.cancelled &&
          playbackRunRef.current.currentAudio === audio
        ) {
          stopAndDisposeAudio(audio, 'current');
          playbackRunRef.current.currentAudio = null;
          playbackRunRef.current.status = 'paused';
          syncReactAudioStateFromRun(playbackRunRef.current);
        }
        return;
      }

      const latestRun = playbackRunRef.current;
      if (
        requestId !== playRequestIdRef.current ||
        sessionId !== playbackSessionRef.current ||
        runId !== latestRun.runId ||
        latestRun.cancelled ||
        latestRun.currentAudio !== audio
      ) {
        stopAndDisposeAudio(audio, 'current');
        return;
      }

      latestRun.status = 'playing';
      pausedTimeRef.current = 0;
      syncReactAudioStateFromRun(latestRun);
    },
    [
      attachAudioLifecycle,
      generateChunkAudio,
      registerCurrentAudio,
      stopAndDisposeAudio,
      syncReactAudioStateFromRun,
    ]
  );

  useEffect(() => {
    playAudioRef.current = playAudio;
  }, [playAudio]);

  const startFromScratch = useCallback(
    async (chunks: AudioChunk[]) => {
      shouldPlayRef.current = false;
      playRequestIdRef.current += 1;
      abortCurrentRun('replace');

      setTrackedAudioState(previousState => ({
        ...previousState,
        chunks,
        currentChunkIndex: 0,
        audioElement: null,
        isPlaying: false,
      }));

      chunkPromisesRef.current = {};
      pausedTimeRef.current = 0;
      shouldPlayRef.current = true;
      beginNewRun(0);
      await playAudio(0, 0);
    },
    [abortCurrentRun, beginNewRun, playAudio, setTrackedAudioState]
  );

  const stopAudio = useCallback(
    (clearChunks = false) => {
      shouldPlayRef.current = false;
      playbackSessionRef.current += 1;
      playRequestIdRef.current += 1;
      abortCurrentRun('stop');
      chunkPromisesRef.current = {};

      if (clearChunks) {
        audioStateRef.current.chunks.forEach(chunk => {
          revokeTrackedUrl(chunk.blobUrl);
        });
      }

      setTrackedAudioState(previousState => ({
        ...previousState,
        isPlaying: false,
        currentChunkIndex: 0,
        audioElement: null,
        chunks: clearChunks ? [] : previousState.chunks,
      }));
      playbackRunRef.current = createIdlePlaybackRun();
      setPlayerCurrentTime(0);
      setPlayerDuration(0);
    },
    [abortCurrentRun, revokeTrackedUrl, setTrackedAudioState]
  );

  const togglePlayPause = useCallback(() => {
    const currentState = audioStateRef.current;

    if (shouldPlayRef.current) {
      shouldPlayRef.current = false;
      playbackSessionRef.current += 1;
      playRequestIdRef.current += 1;
      abortCurrentRun('pause');
      return;
    }

    if (currentState.chunks.length === 0) {
      const chunks = splitContentIntoChunks(sectionContent, speechBlocks);
      const audioChunks: AudioChunk[] = chunks.map((text, index) => ({
        text,
        index,
        blobUrl: null,
        duration: 0,
        isLoading: false,
      }));

      setTrackedAudioState(previousState => ({ ...previousState, chunks: audioChunks }));
      window.setTimeout(() => {
        void startFromScratch(audioChunks);
      }, 0);
      return;
    }

    shouldPlayRef.current = true;
    beginNewRun(currentState.currentChunkIndex);
    void playAudio(currentState.currentChunkIndex, pausedTimeRef.current);
  }, [
    abortCurrentRun,
    beginNewRun,
    playAudio,
    sectionContent,
    setTrackedAudioState,
    speechBlocks,
    startFromScratch,
  ]);

  const handleVoiceChange = useCallback(
    (voice: VoiceProfileId) => {
      if (audioStateRef.current.currentVoice === voice) {
        return;
      }

      stopAudio(true);
      setTrackedAudioState(previousState => ({ ...previousState, currentVoice: voice }));
    },
    [setTrackedAudioState, stopAudio]
  );

  const handleSpeedChange = useCallback(
    (speed: number) => {
      if (audioStateRef.current.playbackRate === speed) {
        return;
      }

      setTrackedAudioState(previousState => ({ ...previousState, playbackRate: speed }));
    },
    [setTrackedAudioState]
  );

  const handleSeek = (time: number) => {
    const currentAudio = playbackRunRef.current.currentAudio;
    if (currentAudio) {
      currentAudio.currentTime = time;
      setPlayerCurrentTime(time);
      return;
    }

    if (playbackRunRef.current.status !== 'paused') {
      return;
    }

    pausedTimeRef.current = time;
    setPlayerCurrentTime(time);
  };

  const handleSkipChunk = (direction: 'prev' | 'next') => {
    const currentState = audioStateRef.current;
    const wasPlaying =
      shouldPlayRef.current &&
      (playbackRunRef.current.status === 'playing' ||
        playbackRunRef.current.status === 'crossfading' ||
        playbackRunRef.current.status === 'starting');

    const nextIndex =
      direction === 'next'
        ? currentState.currentChunkIndex + 1
        : currentState.currentChunkIndex - 1;

    if (nextIndex < 0 || nextIndex >= currentState.chunks.length) {
      return;
    }

    shouldPlayRef.current = false;
    playbackSessionRef.current += 1;
    playRequestIdRef.current += 1;
    abortCurrentRun('skip');
    pausedTimeRef.current = 0;

    setTrackedAudioState(previousState => ({
      ...previousState,
      currentChunkIndex: nextIndex,
      audioElement: null,
      isPlaying: false,
    }));

    if (wasPlaying) {
      shouldPlayRef.current = true;
      beginNewRun(nextIndex);
      void playAudio(nextIndex, 0);
      return;
    }

    playbackRunRef.current.status = 'paused';
    playbackRunRef.current.currentChunkIndex = nextIndex;
    if (!currentState.chunks[nextIndex].blobUrl) {
      void generateChunkAudio(nextIndex);
    }
  };

  useEffect(() => {
    audioStateRef.current = audioState;
  }, [audioState]);

  useEffect(() => {
    const refreshTtsState = async () => {
      try {
        const [status, voices] = await Promise.all([
          OpenRouterService.checkTTSStatus(),
          OpenRouterService.getTTSVoices(),
        ]);
        setTtsConnected(status.isReady);
        if (voices.length > 0) {
          setAvailableVoices(voices);
          const defaultVoice = voices[0].id;
          if (!voices.some(voice => voice.id === audioStateRef.current.currentVoice)) {
            setTrackedAudioState(previousState => ({
              ...previousState,
              currentVoice: defaultVoice,
            }));
          }
        }
      } catch (error) {
        console.warn('[Lumina] TTS status/voices refresh failed', error);
        setTtsConnected(false);
      }
    };

    void refreshTtsState();
    ttsCheckIntervalRef.current = setInterval(refreshTtsState, 10000);

    return () => {
      if (ttsCheckIntervalRef.current) {
        clearInterval(ttsCheckIntervalRef.current);
      }
    };
  }, [setTrackedAudioState]);

  useEffect(() => {
    if (activeSectionId === null) {
      stopAudio(true);
      return;
    }

    stopAudio(true);
  }, [activeSectionId, stopAudio]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: this polling loop intentionally uses refs to read fresh playback state without recreating the interval on every render.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const currentState = audioStateRef.current;
      const run = playbackRunRef.current;
      const audio = run.currentAudio;
      if (!audio) {
        return;
      }

      if (audio.playbackRate !== currentState.playbackRate) {
        audio.playbackRate = currentState.playbackRate;
      }

      if (run.pendingAudio && run.pendingAudio.playbackRate !== currentState.playbackRate) {
        run.pendingAudio.playbackRate = currentState.playbackRate;
      }

      setPlayerCurrentTime(audio.currentTime);
      setPlayerDuration(audio.duration);

      if (audio.paused) {
        return;
      }

      if (
        shouldPlayRef.current &&
        run.status === 'playing' &&
        !run.pendingAudio &&
        run.crossfadeIntervalId === null &&
        audio.duration > 0 &&
        run.currentChunkIndex + 1 < currentState.chunks.length &&
        audio.duration - audio.currentTime <= CHUNK_CROSSFADE_SECONDS
      ) {
        const nextIndex = run.currentChunkIndex + 1;
        const requestId = playRequestIdRef.current;
        const sessionId = playbackSessionRef.current;
        const runId = run.runId;

        void (async () => {
          let nextUrl = currentState.chunks[nextIndex]?.blobUrl;
          if (!nextUrl) {
            nextUrl = await generateChunkAudio(nextIndex);
          }

          const latestRun = playbackRunRef.current;
          if (
            !nextUrl ||
            requestId !== playRequestIdRef.current ||
            sessionId !== playbackSessionRef.current ||
            runId !== latestRun.runId ||
            latestRun.cancelled ||
            latestRun.currentAudio !== audio ||
            latestRun.pendingAudio ||
            !shouldPlayRef.current
          ) {
            return;
          }

          const nextAudio = new Audio(nextUrl);
          nextAudio.playbackRate = currentState.playbackRate;
          nextAudio.volume = 0;
          if (!registerPendingAudio(nextAudio, runId)) {
            return;
          }

          attachAudioLifecycle(nextAudio, nextIndex, requestId, sessionId, runId);
          logPlayback('crossfade start', {
            runId,
            status: 'crossfading',
            chunkIndex: nextIndex,
          });

          try {
            await nextAudio.play();
          } catch (error) {
            console.error('Chunk crossfade start failed', error);
            const failedRun = playbackRunRef.current;
            if (failedRun.runId === runId && failedRun.pendingAudio === nextAudio) {
              stopAndDisposeAudio(nextAudio, 'pending');
              failedRun.pendingAudio = null;
              failedRun.status = failedRun.currentAudio ? 'playing' : 'paused';
              syncReactAudioStateFromRun(failedRun);
            } else {
              stopAndDisposeAudio(nextAudio, 'pending');
            }
            return;
          }

          const validatedRun = playbackRunRef.current;
          if (
            requestId !== playRequestIdRef.current ||
            sessionId !== playbackSessionRef.current ||
            runId !== validatedRun.runId ||
            validatedRun.cancelled ||
            validatedRun.currentAudio !== audio ||
            validatedRun.pendingAudio !== nextAudio ||
            !shouldPlayRef.current
          ) {
            stopAndDisposeAudio(nextAudio, 'pending');
            if (validatedRun.runId === runId && validatedRun.pendingAudio === nextAudio) {
              validatedRun.pendingAudio = null;
              validatedRun.status = validatedRun.currentAudio ? 'playing' : 'paused';
              syncReactAudioStateFromRun(validatedRun);
            }
            return;
          }

          const fadeStart = performance.now();
          validatedRun.crossfadeIntervalId = window.setInterval(() => {
            const activeRun = playbackRunRef.current;
            if (
              activeRun.runId !== runId ||
              activeRun.cancelled ||
              activeRun.currentAudio !== audio ||
              activeRun.pendingAudio !== nextAudio
            ) {
              clearCrossfadeInterval(activeRun);
              return;
            }

            const crossfadeProgress = Math.min(
              1,
              (performance.now() - fadeStart) / (CHUNK_CROSSFADE_SECONDS * 1000)
            );

            audio.volume = 1 - crossfadeProgress;
            nextAudio.volume = crossfadeProgress;

            if (crossfadeProgress < 1) {
              return;
            }

            clearCrossfadeInterval(activeRun);
            audio.volume = 1;
            nextAudio.volume = 1;
            stopAndDisposeAudio(audio, 'current');

            if (!promotePendingAudio(runId, nextIndex)) {
              stopAndDisposeAudio(nextAudio, 'pending');
              return;
            }

            const followingIndex = nextIndex + 1;
            if (followingIndex < audioStateRef.current.chunks.length) {
              void generateChunkAudio(followingIndex);
            }
          }, 10);
        })();
      }
    }, 50);

    return () => {
      clearInterval(interval);
    };
  }, []);

  useEffect(
    () => () => {
      shouldPlayRef.current = false;
      playbackSessionRef.current += 1;
      playRequestIdRef.current += 1;
      abortCurrentRun('unmount');
      playbackRunRef.current = createIdlePlaybackRun();
      generatedObjectUrlsRef.current.forEach(url => {
        URL.revokeObjectURL(url);
      });
      generatedObjectUrlsRef.current.clear();
      chunkPromisesRef.current = {};
    },
    [abortCurrentRun]
  );

  return {
    availableVoices,
    audioState,
    handleSeek,
    handleSkipChunk,
    handleSpeedChange,
    handleVoiceChange,
    playerCurrentTime,
    playerDuration,
    stopAudio,
    togglePlayPause,
    ttsConnected,
  };
};
