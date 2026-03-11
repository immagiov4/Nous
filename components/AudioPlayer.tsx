import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Loader2, Volume2, FastForward, SkipForward, SkipBack, ChevronRight, Crosshair } from 'lucide-react';
import type { VoiceName } from '../types';

interface AudioPlayerProps {
  isPlaying: boolean;
  isLoading: boolean;
  currentVoice: VoiceName;
  playbackRate: number;
  isVertical?: boolean;
  dockOffsetPx?: number;
  isAudioSyncLinked: boolean; 
  currentTime: number;
  duration: number;
  ttsConnected?: boolean; // New: TTS connection status
  onPlayPause: () => void;
  onVoiceChange: (voice: VoiceName) => void;
  onSpeedChange: (speed: number) => void;
  onToggleAudioSyncLink: () => void;
  onSeek: (time: number) => void;
  onSkipChunk: (direction: 'prev' | 'next') => void;
}

const AudioPlayer = ({
  isPlaying,
  isLoading,
  currentVoice,
  playbackRate,
  isVertical = false,
  dockOffsetPx = 0,
  isAudioSyncLinked,
  currentTime,
  duration,
  ttsConnected = false,
  onPlayPause,
  onVoiceChange,
  onSpeedChange,
  onToggleAudioSyncLink,
  onSeek,
  onSkipChunk
}: AudioPlayerProps) => {
  
  // Force a single TTS voice in UI.
  const voices: VoiceName[] = ['Mario' as VoiceName];
  
  // State for docking logic
  const [isHovered, setIsHovered] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Format time mm:ss
  const formatTime = (t: number) => {
    if (!t || Number.isNaN(t)) return "00:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // --- Docking Handlers ---
  const handleMouseEnter = () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    // Keep the player visible a bit less before docking again.
    exitTimerRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 1500);
  };

  // Cleanup
  useEffect(() => {
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, []);

  // --- Styles & Positioning ---

  const isDockedState = isVertical && !isHovered;

  const positionClasses = isVertical
    ? "fixed top-1/2 left-0 z-10 flex items-center" 
    : "fixed bottom-8 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center w-full max-w-xl px-4";

  const transformStyle = isVertical 
    ? {
        left: `${dockOffsetPx}px`,
        transform: isHovered ? 'translateX(14px) translateY(-50%)' : 'translateX(-86%) translateY(-50%)',
        transition: 'left 0.5s cubic-bezier(0.22, 1, 0.36, 1), transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)'
      }
    : {};

  const containerStyle = isDockedState
    ? "bg-white/6 dark:bg-zinc-900/12 border-gray-300/20 dark:border-zinc-500/20 shadow-none backdrop-blur-[1px]"
    : "bg-white/96 dark:bg-zinc-900/96 border-gray-200 dark:border-zinc-700 shadow-xl shadow-black/10";

  const iconColorClass = isDockedState 
    ? "text-gray-600 dark:text-gray-400 opacity-20" // Heavily muted when docked
    : "text-gray-900 dark:text-gray-100";

  const iconHoverClass = "hover:text-orange-600 dark:hover:text-orange-400";

  return (
    <aside
      className={positionClasses}
      style={isVertical ? transformStyle : {}}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
       {/* HIT AREA EXTENSION FOR VERTICAL DOCKING */}
       {isVertical && (
          <div className="absolute inset-y-0 -right-24 w-24 bg-transparent pointer-events-auto cursor-pointer" />
       )}

      {/* DOCKED HANDLE INDICATOR */}
      {isDockedState && (
        <div className="absolute top-1/2 -right-6 -translate-y-1/2 flex flex-col items-center gap-1 opacity-45">
           <div className="w-1 h-8 bg-gray-400/40 dark:bg-zinc-500/40 rounded-full" />
           <ChevronRight className="w-4 h-4 text-gray-500/80 dark:text-zinc-400/80" />
           <div className="w-1 h-8 bg-gray-400/40 dark:bg-zinc-500/40 rounded-full" />
        </div>
      )}

      <div 
        className={`
          relative pointer-events-auto overflow-hidden
          border transition-all duration-300
          ${containerStyle}
          ${isVertical
            ? isDockedState
              ? 'rounded-r-2xl rounded-l-none py-4 px-0 w-5 flex flex-col gap-4'
              : 'rounded-2xl p-4 flex flex-col gap-4 min-w-[100px]'
            : 'rounded-2xl p-4 w-auto flex flex-col gap-2'}
        `}
      >
        
        {/* Timeline (Horizontal Only) */}
        {!isVertical && (
          <div className="w-full flex items-center gap-3 text-[11px] font-mono font-medium text-gray-500 dark:text-gray-400 mb-1 px-1">
              <span className="w-9 text-right">{formatTime(currentTime)}</span>
              <input 
                type="range" 
                min="0" 
                max={duration || 100} 
                value={currentTime}
                onChange={(e) => onSeek(parseFloat(e.target.value))}
                className="flex-1 h-1.5 bg-gray-200 dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-orange-600 dark:accent-orange-500"
              />
              <span className="w-9">{formatTime(duration)}</span>
          </div>
        )}

        {/* Controls Container */}
        <div
          className={`flex items-center justify-center transition-[opacity,transform] duration-200 ${
            isVertical ? 'flex-col gap-5' : 'flex-row gap-8'
          } ${
            isDockedState
              ? 'opacity-0 -translate-x-3 pointer-events-none'
              : 'opacity-100 translate-x-0'
          }`}
          aria-hidden={isDockedState}
        >
          
          {/* Main Transport Controls */}
          <div className={`flex items-center ${isVertical ? 'flex-col gap-4' : 'gap-4'}`}>
              <button type="button" onClick={() => onSkipChunk('prev')} className={`${iconColorClass} ${iconHoverClass} transition-colors p-1 rounded-md hover:bg-gray-100 dark:hover:bg-zinc-800`}>
                <SkipBack className="w-5 h-5" />
              </button>

              <button
              type="button"
              onClick={onPlayPause}
              disabled={!ttsConnected && !isPlaying}
              className={`
                w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-200 shadow-md
                ${isLoading 
                  ? 'bg-gray-100 dark:bg-zinc-800 text-gray-400 cursor-pointer hover:bg-red-50 dark:hover:bg-red-900/10 hover:text-red-500' 
                  : isPlaying 
                    ? 'bg-black dark:bg-white text-white dark:text-black hover:scale-105' 
                    : isDockedState 
                        ? 'bg-transparent border border-current text-gray-400 dark:text-zinc-500' // Ring only in ghost mode
                        : !ttsConnected
                          ? 'bg-gray-300 dark:bg-zinc-700 text-gray-500 dark:text-zinc-400 cursor-not-allowed'
                          : 'bg-black dark:bg-white text-white dark:text-black hover:scale-105 pl-1' 
                }
              `}
              title={!ttsConnected && !isPlaying ? "TTS non disponibile" : isLoading ? "In caricamento (Clicca per annullare/pausa)" : isPlaying ? "Pausa" : "Play"}
            >
              {isLoading ? (
                <div className="relative">
                   <Loader2 className="w-6 h-6 animate-spin" />
                   <Pause className="w-3 h-3 absolute inset-0 m-auto opacity-0 hover:opacity-100 transition-opacity fill-red-500 text-red-500" />
                </div>
              ) : isPlaying ? (
                <Pause className="w-6 h-6 fill-current" />
              ) : (
                <Play className="w-6 h-6 fill-current" />
              )}
            </button>

            <button type="button" onClick={() => onSkipChunk('next')} className={`${iconColorClass} ${iconHoverClass} transition-colors p-1 rounded-md hover:bg-gray-100 dark:hover:bg-zinc-800`}>
                <SkipForward className="w-5 h-5" />
            </button>
          </div>

          {/* Separator */}
          <div className={`${isVertical ? 'w-8 h-px' : 'h-8 w-px'} ${isDockedState ? 'bg-gray-300/20' : 'bg-gray-200 dark:bg-zinc-700'}`} />

          {/* Voice & Speed */}
          <div className={`flex items-center ${isVertical ? 'flex-col gap-4' : 'gap-8'}`}>
            
            {/* Voice */}
            <div className={`flex items-center gap-2 ${isVertical ? 'flex-col' : ''}`}>
               <Volume2 className={`w-4 h-4 ${iconColorClass}`} />
               <select 
                  value={currentVoice}
                  onChange={(e) => onVoiceChange(e.target.value as VoiceName)}
                  className={`bg-transparent text-xs font-bold uppercase tracking-wider focus:outline-none cursor-pointer ${iconColorClass} ${iconHoverClass} text-center appearance-none min-w-[70px]`}
                  disabled={isLoading || isPlaying || !ttsConnected}
                >
                  {voices.map(v => (
                    <option key={v} value={v} className="dark:bg-zinc-800 dark:text-gray-100">{v}</option>
                  ))}
                </select>
            </div>

            {/* Speed */}
            <div className={`flex items-center gap-2 ${isVertical ? 'flex-col' : ''}`}>
              <FastForward className={`w-4 h-4 ${iconColorClass}`} />
              <div className={`flex ${isVertical ? 'flex-col gap-1' : 'gap-1'}`}>
                {[1, 1.25, 1.5].map((rate) => (
                  <button
                    type="button"
                    key={rate}
                    onClick={() => onSpeedChange(rate)}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider transition-colors
                      ${playbackRate === rate 
                        ? (isDockedState ? 'bg-gray-400/20 text-current' : 'bg-black dark:bg-white text-white dark:text-black')
                        : `text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800`
                      }
                    `}
                  >
                    {rate}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Separator */}
          <div className={`${isVertical ? 'w-8 h-px' : 'h-8 w-px'} ${isDockedState ? 'bg-gray-300/20' : 'bg-gray-200 dark:bg-zinc-700'}`} />

          {/* Audio Sync Link Toggle (Mirino) */}
          <button
              type="button"
              onClick={onToggleAudioSyncLink}
              title={isAudioSyncLinked ? "Modalità Focus: Righello legato all'Audio" : "Attiva Modalità Focus (Lega Righello ad Audio)"}
              className={`p-2 rounded-full transition-all duration-300 border 
                ${isAudioSyncLinked
                  ? 'bg-orange-600 text-white border-orange-600 shadow-md'
                  : `bg-transparent border-transparent ${iconColorClass} hover:bg-gray-100 dark:hover:bg-zinc-800`
                }`}
          >
            <Crosshair className={`w-4 h-4 ${isAudioSyncLinked ? 'animate-pulse' : ''}`} />
          </button>

        </div>
      </div>
    </aside>
  );
};

export default AudioPlayer;
