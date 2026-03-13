import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioChunk, AudioState, VoiceName } from '../types';
import * as GeminiService from '../services/geminiService';
import { createWavBlob } from '../services/ttsAudio';
import { prepareMarkdownForSpeech } from '../utils/readingText';

const CHUNK_SIZE_APPROX = 580;
const CHUNK_CROSSFADE_SECONDS = 0.035;

interface UseTtsPlayerParams {
  activeSectionId: string | null;
  backendUrl: string;
  sectionContent: string;
  speechBlocks: string[];
}

interface UseTtsPlayerResult {
  audioState: AudioState;
  calibrationOffset: number;
  handleSeek: (time: number) => void;
  handleSkipChunk: (direction: 'prev' | 'next') => void;
  handleSpeedChange: (speed: number) => void;
  handleToggleAudioSyncLink: () => void;
  handleToggleRuler: () => void;
  handleTTSPlayTest: () => Promise<void>;
  handleVoiceChange: (voice: VoiceName) => void;
  isAudioSyncLinked: boolean;
  isAutoTrackEnabled: boolean;
  isRulerActive: boolean;
  isTestPlaying: boolean;
  playerCurrentTime: number;
  playerDuration: number;
  setCalibrationFromRelativeY: (relativeY: number) => void;
  setTestText: (text: string) => void;
  setTestVoice: (voice: VoiceName) => void;
  stopAudio: (clearChunks?: boolean) => void;
  testText: string;
  testVoice: VoiceName;
  togglePlayPause: () => void;
  ttsConnected: boolean;
  visualProgress: number;
}

const splitOversizedText = (text: string, maxLength: number): string[] => {
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

const splitContentIntoChunks = (text: string, speechBlocks: string[]): string[] => {
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

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
};

export const useTtsPlayer = ({
  activeSectionId,
  backendUrl,
  sectionContent,
  speechBlocks,
}: UseTtsPlayerParams): UseTtsPlayerResult => {
  const [audioState, setAudioState] = useState<AudioState>({
    isPlaying: false,
    currentVoice: 'Marco',
    playbackRate: 1,
    chunks: [],
    currentChunkIndex: 0,
    audioElement: null,
  });
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [visualProgress, setVisualProgress] = useState(0);
  const [isAutoTrackEnabled, setIsAutoTrackEnabled] = useState(false);
  const [calibrationOffset, setCalibrationOffset] = useState(0);
  const [isAudioSyncLinked, setIsAudioSyncLinked] = useState(false);
  const [isRulerActive, setIsRulerActive] = useState(false);
  const [ttsConnected, setTtsConnected] = useState(false);
  const [testVoice, setTestVoice] = useState<VoiceName>('Marco');
  const [testText, setTestText] = useState(
    'Ciao! Sono la tua voce AI. Questo e un test del sistema di sintesi vocale.'
  );
  const [isTestPlaying, setIsTestPlaying] = useState(false);

  const audioStateRef = useRef(audioState);
  const shouldPlayRef = useRef(false);
  const chunkPromisesRef = useRef<Record<number, Promise<string | null>>>({});
  const playbackSessionRef = useRef(0);
  const playRequestIdRef = useRef(0);
  const generatedObjectUrlsRef = useRef<Set<string>>(new Set());
  const ttsCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const chunkCrossfadeRef = useRef<{
    currentAudio: HTMLAudioElement;
    nextAudio: HTMLAudioElement;
    intervalId: number;
  } | null>(null);

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
  }, [backendUrl]);

  const releaseCurrentAudioElement = useCallback(() => {
    disposeAudioElement(audioStateRef.current.audioElement);
  }, [disposeAudioElement]);

  const cleanupChunkCrossfade = useCallback(() => {
    const crossfade = chunkCrossfadeRef.current;
    if (!crossfade) {
      return;
    }

    window.clearInterval(crossfade.intervalId);
    crossfade.currentAudio.volume = 1;
    disposeAudioElement(crossfade.nextAudio);
    chunkCrossfadeRef.current = null;
  }, [disposeAudioElement]);

  const generateChunkAudio = async (index: number, retries = 2): Promise<string | null> => {
    if (audioStateRef.current.chunks[index]?.blobUrl) {
      return audioStateRef.current.chunks[index].blobUrl;
    }

    if (chunkPromisesRef.current[index]) {
      return chunkPromisesRef.current[index];
    }

    const promise = (async () => {
      setAudioState(previousState => {
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
        const pcmBuffer = await GeminiService.generateSpeech(requestedText, requestedVoice);
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

        setAudioState(previousState => {
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

        setAudioState(previousState => {
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
  };

  const handleChunkEnded = (chunkIndex: number, requestId: number, sessionId: number) => {
    if (requestId !== playRequestIdRef.current || sessionId !== playbackSessionRef.current) {
      return;
    }

    const followingIndex = chunkIndex + 1;
    if (followingIndex < audioStateRef.current.chunks.length) {
      if (shouldPlayRef.current) {
        void playAudio(followingIndex);
      }
      return;
    }

    setAudioState(previousState => ({
      ...previousState,
      isPlaying: false,
      currentChunkIndex: 0,
    }));
    setVisualProgress(0);
    shouldPlayRef.current = false;
  };

  const attachAudioLifecycle = (
    audio: HTMLAudioElement,
    chunkIndex: number,
    requestId: number,
    sessionId: number
  ) => {
    audio.onended = () => {
      const activeCrossfade = chunkCrossfadeRef.current;
      if (activeCrossfade?.currentAudio === audio) {
        return;
      }

      handleChunkEnded(chunkIndex, requestId, sessionId);
    };

    audio.onerror = () => {
      if (requestId === playRequestIdRef.current && sessionId === playbackSessionRef.current) {
        setAudioState(previousState => ({ ...previousState, isPlaying: false }));
        shouldPlayRef.current = false;
      }
    };
  };

  const playAudio = async (startIndex = 0): Promise<void> => {
    const requestId = ++playRequestIdRef.current;
    const sessionId = playbackSessionRef.current;
    cleanupChunkCrossfade();
    releaseCurrentAudioElement();

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
        !url
      ) {
        return;
      }
    }

    if (requestId !== playRequestIdRef.current || sessionId !== playbackSessionRef.current) {
      return;
    }

    const audio = new Audio(url);
    audio.playbackRate = audioStateRef.current.playbackRate;
    audio.volume = 1;

    if (!shouldPlayRef.current) {
      return;
    }

    attachAudioLifecycle(audio, startIndex, requestId, sessionId);

    setAudioState(previousState => ({
      ...previousState,
      audioElement: audio,
      currentChunkIndex: startIndex,
      isPlaying: true,
    }));

    const nextIndex = startIndex + 1;
    if (nextIndex < audioStateRef.current.chunks.length) {
      void generateChunkAudio(nextIndex);
    }

    try {
      await audio.play();
    } catch (error) {
      console.error('Play failed', error);
      if (requestId === playRequestIdRef.current && sessionId === playbackSessionRef.current) {
        setAudioState(previousState => ({ ...previousState, isPlaying: false }));
      }
    }
  };

  const startFromScratch = async (chunks: AudioChunk[]) => {
    playbackSessionRef.current += 1;
    releaseCurrentAudioElement();
    playRequestIdRef.current += 1;

    setAudioState(previousState => ({ ...previousState, chunks, currentChunkIndex: 0 }));
    audioStateRef.current = {
      ...audioStateRef.current,
      chunks,
      currentChunkIndex: 0,
      audioElement: null,
      isPlaying: false,
    };
    shouldPlayRef.current = true;
    chunkPromisesRef.current = {};

    await playAudio(0);
  };

  const stopAudio = useCallback((clearChunks = false) => {
    shouldPlayRef.current = false;
    playbackSessionRef.current += 1;
    playRequestIdRef.current += 1;
    cleanupChunkCrossfade();
    releaseCurrentAudioElement();
    chunkPromisesRef.current = {};

    if (clearChunks) {
      audioStateRef.current.chunks.forEach(chunk => {
        revokeTrackedUrl(chunk.blobUrl);
      });
    }

    setAudioState(previousState => ({
      ...previousState,
      isPlaying: false,
      currentChunkIndex: 0,
      audioElement: null,
      chunks: clearChunks ? [] : previousState.chunks,
    }));
    setVisualProgress(0);
    setCalibrationOffset(0);
  }, [cleanupChunkCrossfade, releaseCurrentAudioElement, revokeTrackedUrl]);

  const togglePlayPause = () => {
    const currentAudio = audioStateRef.current.audioElement;

    if (shouldPlayRef.current) {
      shouldPlayRef.current = false;
      cleanupChunkCrossfade();
      currentAudio?.pause();
      setAudioState(previousState => ({ ...previousState, isPlaying: false }));
      return;
    }

    shouldPlayRef.current = true;
    if (currentAudio) {
      currentAudio
        .play()
        .then(() => {
          setAudioState(previousState => ({ ...previousState, isPlaying: true }));
        })
        .catch(error => {
          console.error('Resume failed', error);
          setAudioState(previousState => ({ ...previousState, isPlaying: false }));
        });
      return;
    }

    const currentState = audioStateRef.current;
    if (currentState.chunks.length === 0) {
      const chunks = splitContentIntoChunks(sectionContent, speechBlocks);
      const audioChunks: AudioChunk[] = chunks.map((text, index) => ({
        text,
        index,
        blobUrl: null,
        duration: 0,
        isLoading: false,
      }));

      setAudioState(previousState => ({ ...previousState, chunks: audioChunks }));
      window.setTimeout(() => {
        void startFromScratch(audioChunks);
      }, 0);
      return;
    }

    void playAudio(currentState.currentChunkIndex);
  };

  const handleVoiceChange = (voice: VoiceName) => {
    stopAudio(true);
    setAudioState(previousState => ({ ...previousState, currentVoice: voice }));
  };

  const handleSpeedChange = (speed: number) => {
    setAudioState(previousState => ({ ...previousState, playbackRate: speed }));
  };

  const handleSeek = (time: number) => {
    const currentAudio = audioStateRef.current.audioElement;
    if (!currentAudio) {
      return;
    }

    currentAudio.currentTime = time;
    setPlayerCurrentTime(time);
  };

  const handleSkipChunk = (direction: 'prev' | 'next') => {
    const currentState = audioStateRef.current;
    const wasPlaying =
      shouldPlayRef.current &&
      Boolean(currentState.audioElement) &&
      !currentState.audioElement?.paused;
    cleanupChunkCrossfade();
    releaseCurrentAudioElement();
    playRequestIdRef.current += 1;
    shouldPlayRef.current = wasPlaying;

    const nextIndex =
      direction === 'next'
        ? currentState.currentChunkIndex + 1
        : currentState.currentChunkIndex - 1;

    if (nextIndex >= 0 && nextIndex < currentState.chunks.length) {
      if (wasPlaying) {
        void playAudio(nextIndex);
      } else {
        setAudioState(previousState => ({
          ...previousState,
          currentChunkIndex: nextIndex,
          audioElement: null,
          isPlaying: false,
        }));
        if (!currentState.chunks[nextIndex].blobUrl) {
          void generateChunkAudio(nextIndex);
        }
      }
      return;
    }

    if (wasPlaying && currentState.audioElement) {
      currentState.audioElement.play().catch(error => {
        console.error('Resume after invalid skip failed', error);
      });
    }
  };

  const handleToggleRuler = () => {
    const nextState = !isRulerActive;
    setIsRulerActive(nextState);
    setIsAutoTrackEnabled(nextState);
    if (!nextState) {
      setIsAudioSyncLinked(false);
    }
  };

  const handleToggleAudioSyncLink = () => {
    const nextState = !isAudioSyncLinked;
    setIsAudioSyncLinked(nextState);

    if (!nextState) {
      setIsRulerActive(false);
      setIsAutoTrackEnabled(false);
      return;
    }

    setIsRulerActive(audioState.isPlaying);
    setIsAutoTrackEnabled(audioState.isPlaying);
  };

  const setCalibrationFromRelativeY = useCallback((relativeY: number) => {
    setCalibrationOffset(relativeY - visualProgress);
  }, [visualProgress]);

  const handleTTSPlayTest = async () => {
    if (isTestPlaying && testAudioRef.current) {
      testAudioRef.current.pause();
      setIsTestPlaying(false);
      return;
    }

    setIsTestPlaying(true);
    try {
      const pcmBuffer = await GeminiService.generateSpeech(testText, testVoice);
      const wavBlob = createWavBlob(pcmBuffer);
      const url = URL.createObjectURL(wavBlob);

      testAudioRef.current?.pause();

      const audio = new Audio(url);
      testAudioRef.current = audio;
      audio.onended = () => {
        setIsTestPlaying(false);
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => {
        setIsTestPlaying(false);
        alert('Errore nella riproduzione audio');
      };

      await audio.play();
    } catch (error) {
      console.error('TTS Test error:', error);
      alert(`Errore TTS: ${getErrorMessage(error)}`);
      setIsTestPlaying(false);
    }
  };

  useEffect(() => {
    audioStateRef.current = audioState;
  }, [audioState]);

  useEffect(() => {
    if (isAudioSyncLinked) {
      setIsRulerActive(audioState.isPlaying);
      setIsAutoTrackEnabled(audioState.isPlaying);
    }
  }, [audioState.isPlaying, isAudioSyncLinked]);

  useEffect(() => {
    const checkTTS = async () => {
      try {
        const status = await GeminiService.checkTTSStatus();
        setTtsConnected(status.isReady);
      } catch {
        setTtsConnected(false);
      }
    };

    void checkTTS();
    ttsCheckIntervalRef.current = setInterval(checkTTS, 10000);

    return () => {
      if (ttsCheckIntervalRef.current) {
        clearInterval(ttsCheckIntervalRef.current);
      }
    };
  }, []);

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
      const audio = currentState.audioElement;
      if (!audio) {
        return;
      }

      if (audio.playbackRate !== currentState.playbackRate) {
        audio.playbackRate = currentState.playbackRate;
      }

      setPlayerCurrentTime(audio.currentTime);
      setPlayerDuration(audio.duration);

      if (audio.paused) {
        return;
      }

      const localProgress = audio.duration ? audio.currentTime / audio.duration : 0;
      const totalTextLength = currentState.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
      let processedTextLength = 0;
      for (let index = 0; index < currentState.currentChunkIndex; index += 1) {
        processedTextLength += currentState.chunks[index].text.length;
      }

      const currentChunkLength =
        currentState.chunks[currentState.currentChunkIndex]?.text.length || 0;
      const estimatedGlobalProgress =
        (processedTextLength + currentChunkLength * localProgress) / (totalTextLength || 1);
      setVisualProgress(estimatedGlobalProgress);

      const activeCrossfade = chunkCrossfadeRef.current;
      if (
        shouldPlayRef.current &&
        !activeCrossfade &&
        audio.duration > 0 &&
        currentState.currentChunkIndex + 1 < currentState.chunks.length &&
        audio.duration - audio.currentTime <= CHUNK_CROSSFADE_SECONDS
      ) {
        const nextIndex = currentState.currentChunkIndex + 1;
        const requestId = playRequestIdRef.current;
        const sessionId = playbackSessionRef.current;

        void (async () => {
          let nextUrl = currentState.chunks[nextIndex]?.blobUrl;
          if (!nextUrl) {
            nextUrl = await generateChunkAudio(nextIndex);
          }

          if (
            !nextUrl ||
            chunkCrossfadeRef.current ||
            requestId !== playRequestIdRef.current ||
            sessionId !== playbackSessionRef.current ||
            audio !== audioStateRef.current.audioElement ||
            !shouldPlayRef.current
          ) {
            return;
          }

          const nextAudio = new Audio(nextUrl);
          nextAudio.playbackRate = currentState.playbackRate;
          nextAudio.volume = 0;
          attachAudioLifecycle(nextAudio, nextIndex, requestId, sessionId);

          try {
            await nextAudio.play();
          } catch (error) {
            console.error('Chunk crossfade start failed', error);
            disposeAudioElement(nextAudio);
            return;
          }

          const fadeStart = performance.now();
          const intervalId = window.setInterval(() => {
            const crossfadeProgress = Math.min(
              1,
              (performance.now() - fadeStart) / (CHUNK_CROSSFADE_SECONDS * 1000)
            );

            audio.volume = 1 - crossfadeProgress;
            nextAudio.volume = crossfadeProgress;

            if (crossfadeProgress < 1) {
              return;
            }

            window.clearInterval(intervalId);
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            audio.src = '';
            audio.load();
            audio.volume = 1;
            nextAudio.volume = 1;

            chunkCrossfadeRef.current = null;
            audioStateRef.current = {
              ...audioStateRef.current,
              audioElement: nextAudio,
              currentChunkIndex: nextIndex,
              isPlaying: true,
            };
            setAudioState(previousState => ({
              ...previousState,
              audioElement: nextAudio,
              currentChunkIndex: nextIndex,
              isPlaying: true,
            }));

            const followingIndex = nextIndex + 1;
            if (followingIndex < audioStateRef.current.chunks.length) {
              void generateChunkAudio(followingIndex);
            }
          }, 10);

          chunkCrossfadeRef.current = {
            currentAudio: audio,
            nextAudio,
            intervalId,
          };
        })();
      }
    }, 50);

    return () => {
      clearInterval(interval);
    };
  }, []);

  useEffect(
    () => () => {
      releaseCurrentAudioElement();
      cleanupChunkCrossfade();
      if (testAudioRef.current) {
        testAudioRef.current.pause();
        testAudioRef.current.src = '';
      }
      generatedObjectUrlsRef.current.forEach(url => {
        URL.revokeObjectURL(url);
      });
      generatedObjectUrlsRef.current.clear();
      chunkPromisesRef.current = {};
    },
    [cleanupChunkCrossfade, releaseCurrentAudioElement]
  );

  return {
    audioState,
    calibrationOffset,
    handleSeek,
    handleSkipChunk,
    handleSpeedChange,
    handleToggleAudioSyncLink,
    handleToggleRuler,
    handleTTSPlayTest,
    handleVoiceChange,
    isAudioSyncLinked,
    isAutoTrackEnabled,
    isRulerActive,
    isTestPlaying,
    playerCurrentTime,
    playerDuration,
    setCalibrationFromRelativeY,
    setTestText,
    setTestVoice,
    stopAudio,
    testText,
    testVoice,
    togglePlayPause,
    ttsConnected,
    visualProgress,
  };
};
