import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  ChevronDown,
  Headphones,
  Loader2,
  MousePointer2,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { VoiceProfileId } from '../../types';
import { extractYouTubeVideoId } from '../../utils/youtube.ts';
import { MarkedSlider } from '../shared/MarkedSlider.tsx';
import type { WorkspaceReaderTtsModel, WorkspaceReaderVoiceOption } from './shell/types.ts';

interface UnifiedAudioPanelProps {
  readonly isMobileViewport?: boolean;
  readonly isOpen?: boolean;
  readonly onToggle?: (open: boolean) => void;
  readonly initialTab?: AudioTab;
  readonly onTabChange?: (tab: AudioTab) => void;
  readonly musicUrl: string;
  readonly setMusicUrl: (url: string) => void;
  readonly isMusicPlaying: boolean;
  readonly setIsMusicPlaying: (playing: boolean) => void;
  readonly musicVolume: number;
  readonly setMusicVolume: (vol: number) => void;
  readonly tts: WorkspaceReaderTtsModel;
}

declare global {
  interface YouTubePlayerEvent {
    target: {
      setVolume: (value: number) => void;
      playVideo: () => void;
      pauseVideo: () => void;
    };
    data: number;
  }

  interface YouTubePlayerInstance {
    playVideo: () => void;
    pauseVideo: () => void;
    setVolume: (value: number) => void;
    getPlayerState: () => number;
    destroy?: () => void;
  }

  interface Window {
    YT?: {
      Player: new (
        element: HTMLIFrameElement,
        config: {
          events: {
            onReady: (event: YouTubePlayerEvent) => void;
            onStateChange: (event: YouTubePlayerEvent) => void;
            onError: (event: YouTubePlayerEvent) => void;
          };
        }
      ) => YouTubePlayerInstance;
    };
    onYouTubeIframeAPIReady: () => void;
  }
}

const YOUTUBE_PLAYER_STATE = {
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
} as const;
const PLAYBACK_RATE_MIN = 0.8;
const PLAYBACK_RATE_MAX = 2;
const PLAYBACK_RATE_STEP = 0.05;
const PLAYBACK_RATE_MARKER_COUNT = 5;
const PLAYBACK_RATE_LABEL_WIDTH = 'w-[5ch]';
type AudioTab = 'voce' | 'ambiente';

const getVoiceTabClassName = (isDisabled: boolean, activeTab: AudioTab): string => {
  const baseClassName =
    'relative inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-colors';

  if (isDisabled) {
    return `${baseClassName} cursor-not-allowed text-gray-400 dark:text-zinc-600`;
  }

  if (activeTab === 'voce') {
    return `${baseClassName} text-white dark:text-stone-900`;
  }

  return `${baseClassName} cursor-pointer text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-100`;
};

const getTtsPlayButtonClassName = ({
  isDisabled,
  isLoading,
  isPlaying,
}: {
  isDisabled: boolean;
  isLoading: boolean;
  isPlaying: boolean;
}): string => {
  const baseClassName =
    'flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full shadow-md transition-all duration-200';

  if (isLoading) {
    return `${baseClassName} cursor-pointer bg-gray-100 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:bg-zinc-800 dark:hover:bg-red-900/10`;
  }

  if (isPlaying) {
    return `${baseClassName} bg-black text-white hover:scale-105 dark:bg-white dark:text-black`;
  }

  if (isDisabled) {
    return `${baseClassName} cursor-not-allowed bg-gray-300 text-gray-500 dark:bg-zinc-700 dark:text-zinc-400`;
  }

  return `${baseClassName} bg-black pl-1 text-white hover:scale-105 dark:bg-white dark:text-black`;
};

const getTtsPlayButtonTitle = ({
  isDisabled,
  isLoading,
  isPlaying,
}: {
  isDisabled: boolean;
  isLoading: boolean;
  isPlaying: boolean;
}): string => {
  if (isDisabled) {
    return t('TTS non disponibile');
  }

  if (isLoading) {
    return t('In caricamento');
  }

  return t(isPlaying ? 'Pausa' : 'Riproduci');
};

const formatPlaybackRateLabel = (value: number): string => {
  const fixedValue = value.toFixed(2);
  const [integerPart, fractionalPart = ''] = fixedValue.split('.');
  let endIndex = fractionalPart.length;

  while (endIndex > 0 && fractionalPart[endIndex - 1] === '0') {
    endIndex -= 1;
  }

  const trimmedFraction = fractionalPart.slice(0, endIndex);
  return trimmedFraction ? `${integerPart}.${trimmedFraction}` : integerPart;
};

const normalizePlaybackRate = (value: number): number => {
  const stepsPerUnit = 1 / PLAYBACK_RATE_STEP;
  return Math.round(value * stepsPerUnit) / stepsPerUnit;
};

const clampPlaybackRate = (value: number): number =>
  Math.min(PLAYBACK_RATE_MAX, Math.max(PLAYBACK_RATE_MIN, normalizePlaybackRate(value)));

const getPlaybackRateLabel = (playbackRate: number): string =>
  `${formatPlaybackRateLabel(clampPlaybackRate(playbackRate))}x`;

interface PlaybackSpeedControlProps {
  readonly isDisabled: boolean;
  readonly onSpeedChange: (speed: number) => void;
  readonly playbackRate: number;
}

const PlaybackSpeedControl = ({
  isDisabled,
  onSpeedChange,
  playbackRate,
}: PlaybackSpeedControlProps) => {
  const currentPlaybackRateRef = useRef(clampPlaybackRate(playbackRate));
  const displayedPlaybackRate = clampPlaybackRate(playbackRate);
  const playbackRateLabel = getPlaybackRateLabel(displayedPlaybackRate);

  useEffect(() => {
    currentPlaybackRateRef.current = displayedPlaybackRate;

    if (playbackRate !== displayedPlaybackRate) {
      onSpeedChange(displayedPlaybackRate);
    }
  }, [displayedPlaybackRate, onSpeedChange, playbackRate]);

  const updatePlaybackRate = (value: number) => {
    const nextPlaybackRate = clampPlaybackRate(value);
    if (nextPlaybackRate === currentPlaybackRateRef.current) {
      return;
    }

    currentPlaybackRateRef.current = nextPlaybackRate;
    onSpeedChange(nextPlaybackRate);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    let nextPlaybackRate: number | null = null;

    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      nextPlaybackRate = currentPlaybackRateRef.current + PLAYBACK_RATE_STEP;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      nextPlaybackRate = currentPlaybackRateRef.current - PLAYBACK_RATE_STEP;
    } else if (event.key === 'Home') {
      nextPlaybackRate = PLAYBACK_RATE_MIN;
    } else if (event.key === 'End') {
      nextPlaybackRate = PLAYBACK_RATE_MAX;
    }

    if (nextPlaybackRate === null) {
      return;
    }

    event.preventDefault();
    updatePlaybackRate(nextPlaybackRate);
  };

  return (
    <MarkedSlider
      aria-label={t('Velocita')}
      aria-valuetext={playbackRateLabel}
      title={`${t('Velocita')}: ${playbackRateLabel}`}
      min={PLAYBACK_RATE_MIN}
      max={PLAYBACK_RATE_MAX}
      step={PLAYBACK_RATE_STEP}
      value={displayedPlaybackRate}
      markerCount={PLAYBACK_RATE_MARKER_COUNT}
      disabled={isDisabled}
      onChange={event => updatePlaybackRate(Number.parseFloat(event.target.value))}
      onKeyDown={isDisabled ? undefined : handleKeyDown}
    />
  );
};

const UnifiedAudioPanel = ({
  isMobileViewport = false,
  isOpen: isOpenProp,
  onToggle,
  initialTab = 'voce',
  onTabChange,
  musicUrl,
  setMusicUrl,
  isMusicPlaying,
  setIsMusicPlaying,
  musicVolume,
  setMusicVolume,
  tts,
}: UnifiedAudioPanelProps) => {
  const [isOpenLocal, setIsOpenLocal] = useState(false);
  const isOpen = isOpenProp ?? isOpenLocal;
  const setIsOpen = onToggle
    ? (value: boolean | ((prev: boolean) => boolean)) => {
        const next = typeof value === 'function' ? value(isOpen) : value;
        onToggle(next);
      }
    : setIsOpenLocal;
  const [activeTab, setActiveTab] = useState<AudioTab>(initialTab);

  const [isYtReady, setIsYtReady] = useState(
    () => typeof globalThis.window !== 'undefined' && Boolean(globalThis.window.YT)
  );
  const [playerErrorVideoId, setPlayerErrorVideoId] = useState<string | null>(null);
  const [readyVideoId, setReadyVideoId] = useState<string | null>(null);
  // Lazy-mount the YouTube iframe + API only after the user actually starts the music.
  // Otherwise every project with a saved musicUrl loads the YT API and keeps a hidden
  // iframe alive — that alone consumes ~30% of the tab's CPU on tracking/heartbeat loops.
  const [hasUserActivatedPlayerLocal, setHasUserActivatedPlayerLocal] = useState(isMusicPlaying);

  const inputId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const hasUserActivatedPlayer = hasUserActivatedPlayerLocal || isMusicPlaying;

  const presets = [
    {
      name: 'Anti-anxiety',
      url: 'https://www.youtube.com/watch?v=8p7LwCBgpCE&list=PLeAQnc67cxxRtrDpUavOpv8jzwcFRD0FV',
    },
  ] as const;

  const ttsDisabled = !tts.ttsConnected || !tts.sectionContent;
  const { isTextPickerActive, onSetTextPickerActive } = tts;
  const requestedVideoId = useMemo(() => {
    return extractYouTubeVideoId(musicUrl);
  }, [musicUrl]);
  const hasInvalidMusicUrl = Boolean(musicUrl) && !requestedVideoId;
  const hasPlayerError = requestedVideoId !== null && playerErrorVideoId === requestedVideoId;
  const hasYtError = hasInvalidMusicUrl || hasPlayerError;
  const isPlayerReady = requestedVideoId !== null && readyVideoId === requestedVideoId;
  const isYtApiReady =
    hasUserActivatedPlayer &&
    (isYtReady || (typeof globalThis.window !== 'undefined' && Boolean(globalThis.window.YT)));

  useEffect(() => {
    if ((!isOpen || activeTab !== 'voce') && isTextPickerActive) {
      onSetTextPickerActive(false);
    }
  }, [activeTab, isOpen, isTextPickerActive, onSetTextPickerActive]);

  // A pick in the text starts playback; the panel then gets out of the way. The document capture
  // listener runs before the picker's own click handler, so the close is deferred until the pick is done.
  useEffect(() => {
    if (!isTextPickerActive) return;
    const closeAfterPick = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      globalThis.setTimeout(() => {
        if (onToggle) onToggle(false);
        else setIsOpenLocal(false);
      }, 0);
    };
    document.addEventListener('click', closeAfterPick, true);
    return () => document.removeEventListener('click', closeAfterPick, true);
  }, [isTextPickerActive, onToggle]);

  const handleBackgroundPlayRequest = () => {
    setHasUserActivatedPlayerLocal(true);
    setPlayerErrorVideoId(null);
    setIsMusicPlaying(!isMusicPlaying);
  };

  const handlePresetSelect = (url: string) => {
    setHasUserActivatedPlayerLocal(true);
    setPlayerErrorVideoId(null);
    setMusicUrl(url);
  };

  const getPlayerOrigin = () => {
    if (typeof globalThis.window === 'undefined') return null;
    const { origin, protocol } = globalThis.window.location;
    if ((protocol === 'http:' || protocol === 'https:') && origin && origin !== 'null') {
      return origin;
    }
    return null;
  };

  const getIframeSrc = (id: string) => {
    const params = new URLSearchParams({
      enablejsapi: '1',
      autoplay: '0',
      controls: '0',
      disablekb: '1',
      fs: '0',
      loop: '1',
      playlist: id,
      playsinline: '1',
      rel: '0',
      iv_load_policy: '3',
    });
    const origin = getPlayerOrigin();
    if (origin) {
      params.set('origin', origin);
    }
    return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
  };

  useEffect(() => {
    if (!musicUrl) {
      if (playerRef.current) {
        playerRef.current.destroy?.();
        playerRef.current = null;
      }
      return;
    }
    if (!requestedVideoId) {
      if (playerRef.current) {
        playerRef.current.destroy?.();
        playerRef.current = null;
      }
      setIsMusicPlaying(false);
      return;
    }

    if (playerRef.current) {
      playerRef.current.destroy?.();
      playerRef.current = null;
    }

    setIsMusicPlaying(false);
  }, [musicUrl, requestedVideoId, setIsMusicPlaying]);

  useEffect(() => {
    if (!hasUserActivatedPlayer || isYtApiReady) {
      return;
    }
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
    globalThis.window.onYouTubeIframeAPIReady = () => {
      setIsYtReady(true);
    };
  }, [hasUserActivatedPlayer, isYtApiReady]);

  useEffect(
    () => () => {
      playerRef.current?.destroy?.();
      playerRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (
      isYtApiReady &&
      requestedVideoId &&
      iframeRef.current &&
      !playerRef.current &&
      globalThis.window.YT
    ) {
      try {
        const newPlayer = new globalThis.window.YT.Player(iframeRef.current, {
          events: {
            onReady: event => {
              setReadyVideoId(requestedVideoId);
              event.target.setVolume(musicVolume);
              if (isMusicPlaying) {
                event.target.playVideo();
              }
            },
            onStateChange: event => {
              if (event.data === YOUTUBE_PLAYER_STATE.ENDED) {
                event.target.playVideo();
                return;
              }
              if (event.data === YOUTUBE_PLAYER_STATE.PLAYING) {
                setIsMusicPlaying(true);
                setPlayerErrorVideoId(null);
              }
              if (event.data === YOUTUBE_PLAYER_STATE.PAUSED) setIsMusicPlaying(false);
            },
            onError: event => {
              console.warn('YouTube Player Error:', event.data);
              if (
                event.data === 100 ||
                event.data === 101 ||
                event.data === 150 ||
                event.data === 153
              ) {
                setReadyVideoId(null);
                setPlayerErrorVideoId(requestedVideoId);
                setIsMusicPlaying(false);
              }
            },
          },
        });
        playerRef.current = newPlayer;
      } catch (e) {
        console.error('YT init error', e);
      }
    }
  }, [isMusicPlaying, isYtApiReady, setIsMusicPlaying, requestedVideoId, musicVolume]);

  useEffect(() => {
    const p = playerRef.current;
    if (isPlayerReady && p && typeof p.playVideo === 'function') {
      try {
        if (isMusicPlaying) {
          const state = p.getPlayerState();
          if (state !== YOUTUBE_PLAYER_STATE.PLAYING && state !== YOUTUBE_PLAYER_STATE.BUFFERING) {
            p.playVideo();
          }
        } else if (p.getPlayerState() === YOUTUBE_PLAYER_STATE.PLAYING) {
          p.pauseVideo();
        }
      } catch (error) {
        console.warn('[Nous] YouTube player play/pause failed', error);
      }
    }
  }, [isPlayerReady, isMusicPlaying]);

  useEffect(() => {
    const p = playerRef.current;
    if (isPlayerReady && p && typeof p.setVolume === 'function') {
      p.setVolume(musicVolume);
    }
  }, [isPlayerReady, musicVolume]);

  useEffect(() => {
    if (!isOpen || isTextPickerActive) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        if (onToggle) {
          onToggle(false);
          return;
        }
        setIsOpenLocal(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen, isTextPickerActive, onToggle]);

  const handleRetry = () => {
    setPlayerErrorVideoId(null);
    const currentUrl = musicUrl;
    setMusicUrl('');
    setTimeout(() => setMusicUrl(currentUrl), 100);
  };

  const panelClassName = isMobileViewport
    ? 'fixed left-1/2 top-20 z-50 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 sm:absolute sm:right-0 sm:top-[calc(100%+0.75rem)] sm:left-auto sm:w-[22rem] sm:translate-x-0'
    : 'absolute right-0 top-[calc(100%+0.75rem)] z-50 w-[22rem]';

  const isAudioMenuButtonActive = isOpen || isMusicPlaying || tts.isPlaying;
  let audioMenuButtonClassName: string;

  if (isMobileViewport) {
    audioMenuButtonClassName = isAudioMenuButtonActive
      ? 'inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-0 bg-gray-100/80 p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:bg-zinc-700/50 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-zinc-200'
      : 'inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-2 text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-600 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200';
  } else {
    const desktopAudioMenuStateClassName = isAudioMenuButtonActive
      ? 'border-gray-300 bg-gray-100 text-gray-700 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-zinc-200'
      : 'border-transparent bg-transparent text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-zinc-800 dark:hover:text-gray-300';
    audioMenuButtonClassName = `cursor-pointer rounded-full border p-2 transition-colors ${desktopAudioMenuStateClassName}`;
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-label={t(isOpen ? 'Chiudi menu audio' : 'Apri menu audio')}
        className={audioMenuButtonClassName}
        title={t(isOpen ? 'Chiudi menu audio' : 'Menu audio')}
      >
        <Headphones className={isMobileViewport ? 'reader-mobile-control-icon' : 'h-5 w-5'} />
      </button>

      {isOpen && (
        <AnimatePresence>
          <div key="unified-audio-panel" data-audio-panel-positioner className={panelClassName}>
            <motion.div
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{
                opacity: { duration: 0.09, ease: [0.2, 0.85, 0.25, 1] },
                scale: { duration: 0.12, ease: [0.2, 0.85, 0.25, 1] },
              }}
              style={{
                willChange: 'transform, opacity',
              }}
              className="panel-shadow origin-top overflow-visible rounded-[2rem] border border-gray-200 bg-white px-5 pb-5 pt-4 sm:origin-top-right dark:border-zinc-600/80 dark:bg-[var(--bg-surface)]"
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700 dark:text-zinc-200">
                  {t('Audio')}
                </span>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="cursor-pointer text-gray-400 transition-colors hover:text-gray-700 dark:hover:text-zinc-200"
                  title={t('Chiudi')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="mb-4 flex justify-center">
                <div
                  className="relative inline-flex rounded-full border border-gray-300/80 bg-white p-1 shadow-[0_1px_2px_rgba(24,24,27,0.04)] dark:border-white/10 dark:bg-stone-900/80"
                  role="tablist"
                  aria-label={t('Modalità audio')}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'voce'}
                    onClick={() => {
                      if (!ttsDisabled) {
                        setActiveTab('voce');
                        onTabChange?.('voce');
                      }
                    }}
                    disabled={ttsDisabled}
                    className={getVoiceTabClassName(ttsDisabled, activeTab)}
                  >
                    {activeTab === 'voce' && !ttsDisabled ? (
                      <motion.span
                        layoutId="audio-tab-pill"
                        className="absolute inset-0 rounded-full bg-stone-900 dark:bg-stone-100"
                        transition={{ duration: 0.15, ease: [0.2, 0.85, 0.25, 1] }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="relative z-10">{t('Voce')}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'ambiente'}
                    onClick={() => {
                      setActiveTab('ambiente');
                      onTabChange?.('ambiente');
                    }}
                    className={`relative inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
                      activeTab === 'ambiente'
                        ? 'text-white dark:text-stone-900'
                        : 'cursor-pointer text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-100'
                    }`}
                  >
                    {activeTab === 'ambiente' ? (
                      <motion.span
                        layoutId="audio-tab-pill"
                        className="absolute inset-0 rounded-full bg-stone-900 dark:bg-stone-100"
                        transition={{ duration: 0.15, ease: [0.2, 0.85, 0.25, 1] }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="relative z-10">{t('Ambiente')}</span>
                  </button>
                </div>
              </div>

              {activeTab === 'voce' ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="flex shrink-0 flex-col items-center gap-1">
                      <button
                        type="button"
                        aria-label={t('Scegli dal testo')}
                        aria-pressed={isTextPickerActive}
                        disabled={ttsDisabled}
                        onClick={() => onSetTextPickerActive(!isTextPickerActive)}
                        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-45 ${
                          isTextPickerActive
                            ? 'border-orange-400 bg-orange-100 text-orange-800 dark:border-orange-500 dark:bg-orange-950/60 dark:text-orange-200'
                            : 'border-gray-300 bg-white text-gray-600 hover:border-orange-300 hover:text-orange-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-orange-500/70 dark:hover:text-orange-300'
                        }`}
                        title={
                          isTextPickerActive
                            ? t('Annulla selezione dal testo')
                            : t('Passa sul testo e clicca la parte da leggere')
                        }
                      >
                        <MousePointer2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <div className="flex">
                        <button
                          type="button"
                          aria-label={t('Parte precedente')}
                          onClick={() => tts.onSkipChunk('prev')}
                          disabled={ttsDisabled}
                          className="rounded-md p-0.5 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        >
                          <SkipBack className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('Parte successiva')}
                          onClick={() => tts.onSkipChunk('next')}
                          disabled={ttsDisabled}
                          className="rounded-md p-0.5 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        >
                          <SkipForward className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    <PlaybackPlayButton
                      onClick={tts.onPlayPause}
                      disabled={ttsDisabled}
                      loading={tts.isLoading}
                      playing={tts.isPlaying}
                    />

                    <div className="min-w-0 flex-1">
                      <PlaybackTimeline
                        time={tts.currentTime}
                        duration={tts.duration}
                        onSeek={tts.onSeek}
                        elapsedOnly
                      />
                    </div>
                  </div>

                  <PlaybackVoiceControl tts={tts} disabled={ttsDisabled} />

                  {tts.errorMessage ? (
                    <p className="rounded-xl bg-red-50 px-3 py-2 text-center text-[11px] font-medium leading-5 text-red-700 dark:bg-red-950/30 dark:text-red-200">
                      {tts.errorMessage}
                    </p>
                  ) : ttsDisabled ? (
                    <p className="text-center text-[10px] text-gray-400 dark:text-zinc-500">
                      {t('TTS non disponibile. Carica una lezione per iniziare.')}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor={inputId}
                      className="mb-1 block text-xs font-semibold text-gray-500"
                    >
                      YouTube Link
                    </label>
                    <div className="flex gap-2">
                      <input
                        id={inputId}
                        type="text"
                        value={musicUrl}
                        onChange={e => setMusicUrl(e.target.value)}
                        placeholder={t('incolla link YouTube...')}
                        className={`flex-1 rounded-[1.15rem] border bg-white px-3 py-2 text-xs text-gray-800 outline-none transition-colors focus:border-gray-400 dark:bg-stone-800 dark:text-gray-100 dark:focus:border-zinc-500 ${hasYtError ? 'border-red-300 ring-1 ring-red-100' : 'border-gray-200 dark:border-zinc-500/80'}`}
                      />
                      {hasYtError && (
                        <button
                          type="button"
                          onClick={handleRetry}
                          className="rounded-[1.15rem] bg-red-50 p-2 text-red-500 transition-colors hover:bg-red-100"
                          title={t('Riprova a caricare')}
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {hasYtError && (
                      <div className="mt-2 flex items-start gap-2 rounded-[1.15rem] bg-red-50 p-2 text-[10px] font-medium leading-tight text-red-500 dark:bg-red-900/10">
                        <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                        <span>
                          {t('Link non valido o video limitato da YouTube. Prova un altro link.')}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-4 rounded-[1.5rem] border border-gray-200 bg-white p-3 dark:border-zinc-500/80 dark:bg-stone-800">
                    <button
                      type="button"
                      onClick={handleBackgroundPlayRequest}
                      disabled={!requestedVideoId || hasYtError}
                      aria-label={t(
                        isMusicPlaying ? 'Pausa musica ambiente' : 'Riproduci musica ambiente'
                      )}
                      title={t(
                        isMusicPlaying ? 'Pausa musica ambiente' : 'Riproduci musica ambiente'
                      )}
                      className={`
                        flex h-10 w-10 items-center justify-center rounded-full transition-colors
                        ${
                          requestedVideoId && !hasYtError
                            ? 'bg-gray-900 text-white hover:bg-black dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white'
                            : 'bg-gray-200 dark:bg-zinc-700 text-gray-400 cursor-not-allowed'
                        }
                      `}
                    >
                      {isMusicPlaying ? (
                        <Pause className="w-4 h-4 fill-current" />
                      ) : (
                        <Play className="w-4 h-4 ml-0.5 fill-current" />
                      )}
                    </button>

                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between text-[10px] text-gray-500 font-medium">
                        <div className="flex items-center gap-1">
                          <Volume2 className="w-3 h-3" /> Mix
                        </div>
                        <span>{musicVolume}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={musicVolume}
                        onChange={e => setMusicVolume(Number(e.target.value))}
                        className="h-1 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-gray-700 dark:bg-zinc-700 dark:accent-zinc-300"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 border-t border-gray-200/80 pt-2 dark:border-zinc-700/80">
                    <span className="text-[10px] text-gray-400">Preset:</span>
                    <div className="flex gap-2">
                      {presets.map(preset => (
                        <button
                          type="button"
                          key={preset.url}
                          onClick={() => handlePresetSelect(preset.url)}
                          className="whitespace-nowrap rounded-[1rem] border border-gray-200 bg-white px-2 py-1 text-[10px] text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-500/80 dark:bg-stone-800 dark:text-gray-300 dark:hover:border-zinc-400 dark:hover:text-white"
                        >
                          {preset.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        </AnimatePresence>
      )}

      <div className="absolute w-[1px] h-[1px] opacity-0 pointer-events-none overflow-hidden bottom-0 right-0">
        {hasUserActivatedPlayer && requestedVideoId && (
          <iframe
            ref={iframeRef}
            id="nous-bg-player"
            width="100%"
            height="100%"
            src={getIframeSrc(requestedVideoId)}
            title="Background Music"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            style={{ pointerEvents: 'none' }}
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
      </div>
    </div>
  );
};

export default UnifiedAudioPanel;

export function PlaybackPlayButton({
  onClick,
  disabled = false,
  loading,
  playing,
  stationary = false,
}: {
  onClick: () => void;
  disabled?: boolean;
  loading: boolean;
  playing: boolean;
  stationary?: boolean;
}) {
  const state = { isDisabled: disabled, isLoading: loading, isPlaying: playing };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        stationary
          ? getTtsPlayButtonClassName(state).replace('hover:scale-105', '')
          : getTtsPlayButtonClassName(state)
      }
      title={getTtsPlayButtonTitle(state)}
      aria-label={t(loading ? 'In caricamento' : playing ? 'Pausa' : 'Riproduci')}
    >
      {loading ? (
        <Loader2 className="h-6 w-6 animate-spin" />
      ) : playing ? (
        <Pause className="h-6 w-6 fill-current" />
      ) : (
        <Play className="h-6 w-6 fill-current" />
      )}
    </button>
  );
}
export function PlaybackTimeline({
  time,
  duration,
  onSeek,
  estimated = false,
  elapsedOnly = false,
}: {
  estimated?: boolean;
  /** Shows only the current position, after the slider, without the total duration. */
  elapsedOnly?: boolean;
  time: number;
  duration: number;
  onSeek: (time: number) => void;
}) {
  const formatTime = (value: number) => {
    if (!value || Number.isNaN(value)) {
      return '00:00';
    }
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex items-center gap-3 px-1 font-mono text-[11px] font-medium text-gray-500 dark:text-gray-400">
      {elapsedOnly ? null : <span className="w-9 shrink-0 text-right">{formatTime(time)}</span>}
      <input
        type="range"
        aria-label={t('Posizione audio')}
        disabled={duration <= 0}
        min="0"
        max={duration || 100}
        value={time}
        onChange={event => onSeek(parseFloat(event.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-lg bg-gray-200 accent-gray-900 dark:bg-zinc-700 dark:accent-zinc-100"
      />
      {elapsedOnly ? (
        <span className="w-9 shrink-0 text-right">{formatTime(time)}</span>
      ) : (
        <span className="shrink-0 whitespace-nowrap">
          {estimated ? '≈ ' : ''}
          {formatTime(duration)}
        </span>
      )}
    </div>
  );
}
export function PlaybackVoiceControl({
  tts,
  disabled: ttsDisabled = false,
  compact = false,
}: {
  tts: Pick<
    WorkspaceReaderTtsModel,
    'currentVoice' | 'availableVoices' | 'playbackRate' | 'onVoiceChange' | 'onSpeedChange'
  >;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayedVoices: WorkspaceReaderVoiceOption[] = tts.availableVoices.some(
    voice => voice.id === tts.currentVoice
  )
    ? tts.availableVoices
    : [
        { id: tts.currentVoice, label: tts.currentVoice, language: 'custom' },
        ...tts.availableVoices,
      ];
  const currentVoiceLabel =
    displayedVoices.find(voice => voice.id === tts.currentVoice)?.label ?? tts.currentVoice;
  const playbackRateLabel = getPlaybackRateLabel(tts.playbackRate);

  const control = (
    <fieldset className="min-w-0 w-full rounded-3xl border border-gray-200 bg-white px-3 pb-3 shadow-sm focus-within:border-orange-300 focus-within:ring-2 focus-within:ring-orange-100 dark:border-zinc-700 dark:bg-zinc-800 dark:focus-within:border-orange-500/70 dark:focus-within:ring-orange-500/15">
      <legend className="sr-only">{`${t('Voce')} · ${t('Velocita')}`}</legend>
      <div className="relative min-h-10">
        <select
          aria-label={t('Voce')}
          title={t('Voce')}
          value={tts.currentVoice}
          onChange={event => tts.onVoiceChange(event.target.value as VoiceProfileId)}
          className="absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
          disabled={ttsDisabled}
        >
          {displayedVoices.map(voice => (
            <option key={voice.id} value={voice.id}>
              {voice.label}
            </option>
          ))}
        </select>

        <div
          aria-hidden="true"
          className={`pointer-events-none flex min-h-10 items-center gap-2 px-1 text-sm font-medium ${
            ttsDisabled ? 'text-gray-400 dark:text-zinc-500' : 'text-gray-700 dark:text-zinc-200'
          }`}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="truncate">{currentVoiceLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-zinc-500" />
          </span>
          <span className={`${PLAYBACK_RATE_LABEL_WIDTH} shrink-0 text-right tabular-nums`}>
            {playbackRateLabel}
          </span>
        </div>
      </div>

      <PlaybackSpeedControl
        isDisabled={ttsDisabled}
        onSpeedChange={tts.onSpeedChange}
        playbackRate={tts.playbackRate}
      />
    </fieldset>
  );
  if (!compact) return control;
  return (
    <div className="relative min-w-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`${t('Voce')} · ${t('Velocita')}`}
        className="flex min-h-10 max-w-full items-center gap-1.5 rounded-3xl border border-gray-200 bg-white px-3.5 text-sm font-medium text-gray-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
      >
        <span className="truncate">{currentVoiceLabel}</span>
        <span className="text-gray-300 dark:text-zinc-600">·</span>
        {/* Fixed width: the widest label is "1.05x", so speed changes never shift the layout. */}
        <span className={`${PLAYBACK_RATE_LABEL_WIDTH} shrink-0 text-left tabular-nums`}>
          {playbackRateLabel}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" />
      </button>
      <AnimatePresence>
        {expanded ? (
          // Anchored to the left edge so the menu stays put when the speed label grows.
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15, ease: [0.2, 0.85, 0.25, 1] }}
            className="absolute bottom-full left-0 z-50 mb-2 w-56"
          >
            {control}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
