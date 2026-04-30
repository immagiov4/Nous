import {
  ChevronRight,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceProfileId } from '../../types';
import { subscribeToMediaQuery } from '../../utils/dom/mediaQuery.ts';

interface AudioPlayerProps {
  isPlaying: boolean;
  isLoading: boolean;
  availableVoices: Array<{ id: VoiceProfileId; label: string; language: string }>;
  currentVoice: VoiceProfileId;
  playbackRate: number;
  isVertical?: boolean;
  dockOffsetPx?: number;
  currentTime: number;
  duration: number;
  ttsConnected?: boolean;
  onPlayPause: () => void;
  onVoiceChange: (voice: VoiceProfileId) => void;
  onSpeedChange: (speed: number) => void;
  onSeek: (time: number) => void;
  onSkipChunk: (direction: 'prev' | 'next') => void;
}

const MOBILE_DOCK_VISIBILITY_MS = 1300;

const AudioPlayer = ({
  isPlaying,
  isLoading,
  availableVoices,
  currentVoice,
  playbackRate,
  isVertical = false,
  dockOffsetPx = 0,
  currentTime,
  duration,
  ttsConnected = false,
  onPlayPause,
  onVoiceChange,
  onSpeedChange,
  onSeek,
  onSkipChunk,
}: AudioPlayerProps) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isTouchExpanded, setIsTouchExpanded] = useState(false);
  const [isTouchDockVisible, setIsTouchDockVisible] = useState(true);
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);
  const [isSpeedPickerOpen, setIsSpeedPickerOpen] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dockVisibilityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const formatTime = (value: number) => {
    if (!value || Number.isNaN(value)) {
      return '00:00';
    }

    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleMouseEnter = () => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
    }
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    if (isCoarsePointer) {
      return;
    }

    exitTimerRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 1500);
  };

  const scheduleTouchDock = () => {
    if (!isCoarsePointer) {
      return;
    }

    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
    }

    exitTimerRef.current = setTimeout(() => {
      setIsTouchExpanded(false);
    }, 2200);
  };

  const showTouchDockBriefly = useCallback(() => {
    if (!isCoarsePointer || !isVertical) {
      return;
    }

    setIsTouchDockVisible(true);

    if (dockVisibilityTimerRef.current) {
      clearTimeout(dockVisibilityTimerRef.current);
    }

    dockVisibilityTimerRef.current = setTimeout(() => {
      setIsTouchDockVisible(false);
    }, MOBILE_DOCK_VISIBILITY_MS);
  }, [isCoarsePointer, isVertical]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia('(pointer: coarse)');
    const updatePointerMode = () => {
      setIsCoarsePointer(mediaQuery.matches);
    };

    updatePointerMode();
    return subscribeToMediaQuery(mediaQuery, updatePointerMode);
  }, []);

  useEffect(() => {
    if (!isCoarsePointer && isTouchExpanded) {
      setIsTouchExpanded(false);
    }
  }, [isCoarsePointer, isTouchExpanded]);

  useEffect(() => {
    if (!isCoarsePointer || !isVertical || typeof window === 'undefined') {
      return;
    }

    showTouchDockBriefly();
    window.addEventListener('pointerdown', showTouchDockBriefly, { passive: true });
    window.addEventListener('scroll', showTouchDockBriefly, { passive: true, capture: true });
    return () => {
      window.removeEventListener('pointerdown', showTouchDockBriefly);
      window.removeEventListener('scroll', showTouchDockBriefly, true);
      if (dockVisibilityTimerRef.current) {
        clearTimeout(dockVisibilityTimerRef.current);
      }
    };
  }, [isCoarsePointer, isVertical, showTouchDockBriefly]);

  useEffect(
    () => () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
      }
      if (dockVisibilityTimerRef.current) {
        clearTimeout(dockVisibilityTimerRef.current);
      }
    },
    []
  );

  const isDockedState = isVertical && !(isCoarsePointer ? isTouchExpanded : isHovered);
  const displayedVoices = availableVoices.some(voice => voice.id === currentVoice)
    ? availableVoices
    : [{ id: currentVoice, label: currentVoice, language: 'custom' }, ...availableVoices];
  const normalizedPlaybackRate = Math.round(playbackRate * 20) / 20;

  const positionClasses = isVertical
    ? isCoarsePointer
      ? 'fixed bottom-12 left-0 z-40 flex items-end'
      : 'fixed top-1/2 left-0 z-20 flex items-center'
    : 'fixed bottom-8 left-1/2 z-10 flex w-full max-w-xl -translate-x-1/2 flex-col items-center px-4';

  const transformStyle = isVertical
    ? isCoarsePointer
      ? {
          bottom: 'env(safe-area-inset-bottom, 0px)',
          transform: isDockedState ? 'translateX(-95%)' : 'translateX(0)',
          transition: 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }
      : {
          left: `${dockOffsetPx}px`,
          transform: isDockedState
            ? 'translateX(-86%) translateY(-50%)'
            : 'translateX(14px) translateY(-50%)',
          transition:
            'left 0.5s cubic-bezier(0.22, 1, 0.36, 1), transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }
    : {};

  const containerStyle = isDockedState
    ? isCoarsePointer
      ? 'border-gray-200/90 bg-white/96 shadow-lg shadow-black/10 backdrop-blur-md dark:border-zinc-600/80 dark:bg-zinc-900/96'
      : 'border-gray-300/20 bg-white/6 shadow-none backdrop-blur-[1px] dark:border-zinc-500/20 dark:bg-zinc-900/12'
    : 'border-gray-200 bg-white shadow-2xl shadow-black/15 dark:border-zinc-600/80 dark:bg-zinc-900';

  const iconColorClass = isDockedState
    ? isCoarsePointer
      ? 'text-gray-700 opacity-95 dark:text-zinc-200'
      : 'text-gray-600 opacity-20 dark:text-gray-400'
    : 'text-gray-900 dark:text-gray-100';
  const iconHoverClass = 'hover:text-gray-900 dark:hover:text-gray-100';

  return (
    <aside
      className={positionClasses}
      style={isVertical ? transformStyle : {}}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={() => {
        if (isCoarsePointer) {
          showTouchDockBriefly();
        }
        if (isCoarsePointer && !isDockedState) {
          scheduleTouchDock();
        }
      }}
    >
      {isVertical && !isCoarsePointer ? (
        <div className="absolute inset-y-0 -right-24 w-24 cursor-pointer bg-transparent pointer-events-auto" />
      ) : null}

      {isDockedState ? (
        isCoarsePointer ? (
          <button
            type="button"
            onClick={() => {
              setIsTouchExpanded(true);
              setIsTouchDockVisible(true);
              scheduleTouchDock();
            }}
            className={`absolute top-1/2 -right-6 -translate-y-1/2 flex items-center justify-center rounded-full border border-gray-200 bg-white p-2 text-gray-700 shadow-lg shadow-black/10 transition-opacity dark:border-zinc-600/80 dark:bg-zinc-900 dark:text-zinc-100 ${
              isTouchDockVisible
                ? 'pointer-events-auto opacity-100'
                : 'pointer-events-none opacity-0'
            }`}
            aria-label="Apri player TTS"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <div className="pointer-events-none absolute top-1/2 -right-6 -translate-y-1/2 flex flex-col items-center gap-1 opacity-95">
            <div className="h-8 w-1 rounded-full bg-gray-500/55 dark:bg-zinc-300/45" />
            <ChevronRight className="h-4 w-4 text-gray-700 dark:text-zinc-200" />
            <div className="h-8 w-1 rounded-full bg-gray-500/55 dark:bg-zinc-300/45" />
          </div>
        )
      ) : null}

      {isVertical && isCoarsePointer && !isDockedState ? (
        <button
          type="button"
          onClick={() => {
            setIsTouchExpanded(false);
            if (exitTimerRef.current) {
              clearTimeout(exitTimerRef.current);
            }
          }}
          className="absolute top-1/2 -right-6 z-10 flex -translate-y-1/2 items-center justify-center rounded-full border border-gray-200 bg-white p-2 text-gray-700 shadow-lg shadow-black/10 dark:border-zinc-600/80 dark:bg-zinc-900 dark:text-zinc-100"
          aria-label="Riduci player TTS"
        >
          <ChevronRight className="h-4 w-4 rotate-180" />
        </button>
      ) : null}

      <div
        className={`
          relative overflow-visible border pointer-events-auto transition-all duration-300
          ${containerStyle}
          ${
            isVertical
              ? isDockedState
                ? 'flex w-7 flex-col gap-4 rounded-r-2xl rounded-l-none px-0 py-4'
                : 'relative flex min-w-[100px] flex-col gap-4 rounded-2xl p-4'
              : 'flex w-auto flex-col gap-2 rounded-2xl p-4'
          }
        `}
      >
        {!isVertical ? (
          <div className="mb-1 flex w-full items-center gap-3 px-1 font-mono text-[11px] font-medium text-gray-500 dark:text-gray-400">
            <span className="w-9 text-right">{formatTime(currentTime)}</span>
            <input
              type="range"
              min="0"
              max={duration || 100}
              value={currentTime}
              onChange={event => onSeek(parseFloat(event.target.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-lg bg-gray-200 accent-gray-900 dark:bg-zinc-700 dark:accent-zinc-100"
            />
            <span className="w-9">{formatTime(duration)}</span>
          </div>
        ) : null}

        <div
          className={`flex flex-col items-center justify-center gap-2.5 transition-[opacity,transform] duration-200 ${
            isDockedState
              ? 'pointer-events-none -translate-x-3 opacity-0'
              : 'translate-x-0 opacity-100'
          }`}
          aria-hidden={isDockedState}
        >
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onSkipChunk('prev')}
              className={`${iconColorClass} ${iconHoverClass} rounded-md p-1 transition-colors hover:bg-gray-100 dark:hover:bg-zinc-800`}
            >
              <SkipBack className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={onPlayPause}
              disabled={!ttsConnected && !isPlaying}
              className={`
                flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full shadow-md transition-all duration-200
                ${
                  isLoading
                    ? 'cursor-pointer bg-gray-100 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:bg-zinc-800 dark:hover:bg-red-900/10'
                    : isPlaying
                      ? 'bg-black text-white hover:scale-105 dark:bg-white dark:text-black'
                      : isDockedState
                        ? 'border border-current bg-transparent text-gray-500 dark:text-zinc-400'
                        : !ttsConnected
                          ? 'cursor-not-allowed bg-gray-300 text-gray-500 dark:bg-zinc-700 dark:text-zinc-400'
                          : 'bg-black pl-1 text-white hover:scale-105 dark:bg-white dark:text-black'
                }
              `}
              title={
                !ttsConnected && !isPlaying
                  ? 'TTS non disponibile'
                  : isLoading
                    ? 'In caricamento'
                    : isPlaying
                      ? 'Pausa'
                      : 'Play'
              }
            >
              {isLoading ? (
                <div className="relative">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <Pause className="absolute inset-0 m-auto h-3 w-3 fill-red-500 text-red-500 opacity-0 transition-opacity hover:opacity-100" />
                </div>
              ) : isPlaying ? (
                <Pause className="h-6 w-6 fill-current" />
              ) : (
                <Play className="h-6 w-6 fill-current" />
              )}
            </button>

            <button
              type="button"
              onClick={() => onSkipChunk('next')}
              className={`${iconColorClass} ${iconHoverClass} rounded-md p-1 transition-colors hover:bg-gray-100 dark:hover:bg-zinc-800`}
            >
              <SkipForward className="h-5 w-5" />
            </button>
          </div>

          <div className="flex items-center rounded-lg border border-gray-200/80 dark:border-zinc-700/80">
              <select
                value={currentVoice}
                onChange={event => onVoiceChange(event.target.value as VoiceProfileId)}
                className={`cursor-pointer appearance-none border-0 bg-transparent px-2 text-center text-xs font-medium text-gray-700 transition-colors hover:bg-black/5 focus:outline-none dark:text-zinc-200 dark:hover:bg-white/10 ${
                  isDockedState ? 'opacity-60' : ''
                }`}
                disabled={isLoading || !ttsConnected}
              >
                {displayedVoices.map(voice => (
                  <option
                    key={voice.id}
                    value={voice.id}
                    className={`dark:bg-zinc-800 dark:text-gray-100 ${
                      voice.id === currentVoice ? 'font-semibold' : 'font-normal'
                    }`}
                  >
                    {voice.label}
                  </option>
                ))}
              </select>

              <div className="h-3.5 w-px self-stretch bg-gray-200 dark:bg-zinc-700" />

              <div className="relative inline-flex items-center">
                <button
                  type="button"
                  onClick={() => setIsSpeedPickerOpen(current => !current)}
                  className="cursor-pointer border-0 bg-transparent px-2 text-xs font-medium text-gray-500 transition-colors hover:bg-black/5 focus:outline-none dark:text-zinc-400 dark:hover:bg-white/10"
                  aria-expanded={isSpeedPickerOpen}
                >
                  {normalizedPlaybackRate.toFixed(2).replace(/\.?0+$/, '')}x
                </button>
                {isSpeedPickerOpen ? (
                  <div
                    className={`absolute z-30 rounded-xl border border-gray-200 bg-white p-3 shadow-xl shadow-black/10 dark:border-zinc-700 dark:bg-zinc-900 ${
                      isVertical
                        ? 'left-[calc(100%+0.5rem)] top-1/2 w-40 -translate-y-1/2'
                        : 'bottom-[calc(100%+0.5rem)] right-0 w-44'
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between text-xs text-gray-500 dark:text-zinc-400">
                      <span>Velocita</span>
                      <span className="font-medium text-gray-800 dark:text-zinc-100">
                        {normalizedPlaybackRate.toFixed(2).replace(/\.?0+$/, '')}x
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.8"
                      max="1.6"
                      step="0.05"
                      value={normalizedPlaybackRate}
                      onChange={event => onSpeedChange(Number.parseFloat(event.target.value))}
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-200 accent-gray-900 dark:bg-zinc-700 dark:accent-zinc-100"
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
    </aside>
  );
};

export default AudioPlayer;
