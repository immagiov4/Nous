import { useEffect, useRef, useState } from 'react';
import { ChevronRight, FastForward, Loader2, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react';
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
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(
    () => () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
      }
    },
    []
  );

  const isDockedState = isVertical && !(isCoarsePointer ? isTouchExpanded : isHovered);

  const positionClasses = isVertical
    ? isCoarsePointer
      ? 'fixed bottom-0 left-0 z-40 flex items-end'
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
          transition: 'left 0.5s cubic-bezier(0.22, 1, 0.36, 1), transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
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
  const iconHoverClass = 'hover:text-orange-600 dark:hover:text-orange-400';

  return (
    <aside
      className={positionClasses}
      style={isVertical ? transformStyle : {}}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={() => {
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
              scheduleTouchDock();
            }}
            className="absolute top-1/2 -right-6 -translate-y-1/2 flex items-center justify-center rounded-full border border-gray-200 bg-white p-2 text-gray-700 shadow-lg shadow-black/10 dark:border-zinc-600/80 dark:bg-zinc-900 dark:text-zinc-100"
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
          relative overflow-hidden border pointer-events-auto transition-all duration-300
          ${containerStyle}
          ${isVertical
            ? isDockedState
              ? 'flex w-7 flex-col gap-4 rounded-r-2xl rounded-l-none px-0 py-4'
              : 'relative flex min-w-[100px] flex-col gap-4 rounded-2xl p-4'
            : 'flex w-auto flex-col gap-2 rounded-2xl p-4'}
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
              onChange={(event) => onSeek(parseFloat(event.target.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-lg bg-gray-200 accent-orange-600 dark:bg-zinc-700 dark:accent-orange-500"
            />
            <span className="w-9">{formatTime(duration)}</span>
          </div>
        ) : null}

        <div
          className={`flex items-center justify-center transition-[opacity,transform] duration-200 ${
            isVertical ? 'flex-col gap-5' : 'flex-row gap-8'
          } ${
            isDockedState
              ? 'pointer-events-none -translate-x-3 opacity-0'
              : 'translate-x-0 opacity-100'
          }`}
          aria-hidden={isDockedState}
        >
          <div className={`flex items-center ${isVertical ? 'flex-col gap-4' : 'gap-4'}`}>
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
                flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full shadow-md transition-all duration-200
                ${isLoading
                  ? 'cursor-pointer bg-gray-100 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:bg-zinc-800 dark:hover:bg-red-900/10'
                  : isPlaying
                    ? 'bg-black text-white hover:scale-105 dark:bg-white dark:text-black'
                    : isDockedState
                      ? 'border border-current bg-transparent text-gray-500 dark:text-zinc-400'
                      : !ttsConnected
                        ? 'cursor-not-allowed bg-gray-300 text-gray-500 dark:bg-zinc-700 dark:text-zinc-400'
                        : 'bg-black pl-1 text-white hover:scale-105 dark:bg-white dark:text-black'}
              `}
              title={!ttsConnected && !isPlaying ? 'TTS non disponibile' : isLoading ? 'In caricamento' : isPlaying ? 'Pausa' : 'Play'}
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

          <div className={`${isVertical ? 'h-px w-8' : 'h-8 w-px'} ${isDockedState ? 'bg-gray-300/20' : 'bg-gray-200 dark:bg-zinc-700'}`} />

          <div className={`flex items-center ${isVertical ? 'flex-col gap-4' : 'gap-8'}`}>
            <div className={`flex items-center gap-2 ${isVertical ? 'flex-col' : ''}`}>
              <Volume2 className={`h-4 w-4 ${iconColorClass}`} />
                <select
                value={currentVoice}
                onChange={(event) => onVoiceChange(event.target.value as VoiceProfileId)}
                className={`min-w-[70px] cursor-pointer appearance-none bg-transparent text-center text-xs font-bold uppercase tracking-wider focus:outline-none ${iconColorClass} ${iconHoverClass}`}
                disabled={isLoading || isPlaying || !ttsConnected}
              >
                {availableVoices.map((voice) => (
                  <option key={voice.id} value={voice.id} className="dark:bg-zinc-800 dark:text-gray-100">
                    {voice.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={`flex items-center gap-2 ${isVertical ? 'flex-col' : ''}`}>
              <FastForward className={`h-4 w-4 ${iconColorClass}`} />
              <div className={`flex ${isVertical ? 'flex-col gap-1' : 'gap-1'}`}>
                {[1, 1.25, 1.5].map((rate) => (
                  <button
                    type="button"
                    key={rate}
                    onClick={() => onSpeedChange(rate)}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                      playbackRate === rate
                        ? isDockedState
                          ? 'bg-gray-400/20 text-current'
                          : 'bg-black text-white dark:bg-white dark:text-black'
                        : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {rate}x
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};

export default AudioPlayer;
