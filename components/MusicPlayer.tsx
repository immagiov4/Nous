import { useEffect, useId, useRef, useState } from 'react';
import { Headphones, Music, Volume2, X, Play, Pause, AlertCircle, RefreshCw } from 'lucide-react';

interface MusicPlayerProps {
  url: string;
  setUrl: (url: string) => void;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  volume: number;
  setVolume: (vol: number) => void;
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

const MusicPlayer = ({ 
  url, setUrl, isPlaying, setIsPlaying, volume, setVolume 
}: MusicPlayerProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const inputId = useId();
  const presets = [
    { name: 'Lofi Girl', url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' },
    { name: 'Synthwave', url: 'https://www.youtube.com/watch?v=4xDzrJKXOOY' },
    { name: 'Rain', url: 'https://www.youtube.com/watch?v=5qap5aO4i9A' },
    { name: 'Classical', url: 'https://www.youtube.com/watch?v=M73x3O7dhmg' },
  ] as const;
  
  // Use a Ref for the iframe directly
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);

  // Extract Video ID from URL
  useEffect(() => {
    setHasError(false);
    if (!url) {
        setVideoId(null);
        return;
    }
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    const id = (match && match[2].length === 11) ? match[2] : null;
    
    if (id && id !== videoId) {
        setVideoId(id);
        // Reset player ref when video changes to force re-attachment
        playerRef.current = null;
    }
  }, [url, videoId]);

  // Load YouTube API
  useEffect(() => {
    if (!window.YT) {
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
          const tag = document.createElement('script');
          tag.src = "https://www.youtube.com/iframe_api";
          document.head.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = () => {
        setIsReady(true);
      };
    } else {
      setIsReady(true);
    }
  }, []);

  // Initialize Player attached to existing Iframe
  useEffect(() => {
    if (isReady && videoId && iframeRef.current && !playerRef.current) {
        try {
            const newPlayer = new window.YT.Player(iframeRef.current, {
                events: {
                    onReady: event => {
                        event.target.setVolume(volume);
                        if (isPlaying) {
                            event.target.playVideo();
                        }
                    },
                    onStateChange: event => {
                        if (event.data === 1) { // Playing
                            setIsPlaying(true);
                            setHasError(false);
                        }
                        if (event.data === 2) setIsPlaying(false); // Paused
                    },
                    onError: event => {
                        console.warn('YouTube Player Error:', event.data);
                        // Errors: 150/101 = restricted embed.
                        if (event.data === 100 || event.data === 101 || event.data === 150) {
                            setHasError(true);
                            setIsPlaying(false);
                        }
                    }
                }
            });
            playerRef.current = newPlayer;
        } catch (e) {
            console.error('YT init error', e);
        }
    }
  }, [isPlaying, isReady, setIsPlaying, videoId, volume]);

  // Handle Play/Pause via API
  useEffect(() => {
    const p = playerRef.current;
    if (p && typeof p.playVideo === 'function') {
      try {
          if (isPlaying) {
             const state = p.getPlayerState();
             if (state !== 1 && state !== 3) p.playVideo();
          } else {
             if (p.getPlayerState() === 1) p.pauseVideo();
          }
      } catch {}
    }
  }, [isPlaying]);

  // Handle Volume via API
  useEffect(() => {
    const p = playerRef.current;
    if (p && typeof p.setVolume === 'function') {
      p.setVolume(volume);
    }
  }, [volume]);

  const handleRetry = () => {
      setHasError(false);
      const currentUrl = url;
      setUrl('');
      setTimeout(() => setUrl(currentUrl), 100);
  };

  // Construct src manually - Using nocookie and MINIMAL parameters to reduce validation strictness
  const getIframeSrc = (id: string) => {
      // We removed 'origin' parameter to avoid strict CORS checks that trigger error 153/150 in some environments
      return `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&autoplay=0&controls=0&disablekb=1&fs=0&playsinline=1&rel=0&iv_load_policy=3`;
  };

  return (
    <div className="relative">
      <button 
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`
            p-2 rounded-full transition-all duration-300 border
            ${isOpen || isPlaying 
                ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800 shadow-sm' 
                : 'bg-transparent border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'
            }
            ${hasError ? 'text-red-500 border-red-200 bg-red-50' : ''}
        `}
        title="Musica di sottofondo (YouTube)"
      >
        <Headphones className={`w-5 h-5 ${isPlaying ? 'animate-pulse' : ''}`} />
      </button>

      {isOpen && (
        <>
            <button
              type="button"
              aria-label="Chiudi pannello musica"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setIsOpen(false)}
            />
            <div className="absolute right-0 top-12 z-50 w-80 bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-gray-200 dark:border-zinc-800 p-4 animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-bold text-sm">
                        <Music className="w-4 h-4" />
                        <span>Background Mood</span>
                    </div>
                    <button type="button" onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="space-y-4">
                    <div>
                        <label htmlFor={inputId} className="block text-xs font-semibold text-gray-500 mb-1">YouTube Link</label>
                        <div className="flex gap-2">
                            <input 
                                id={inputId}
                                type="text" 
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="incolla link YouTube..."
                                className={`flex-1 px-3 py-2 bg-gray-50 dark:bg-zinc-800 border rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 outline-none text-gray-800 dark:text-gray-200 ${hasError ? 'border-red-300 ring-1 ring-red-100' : 'border-gray-200 dark:border-zinc-700'}`}
                            />
                            {hasError && (
                                <button 
                                    type="button"
                                    onClick={handleRetry}
                                    className="p-2 bg-red-50 text-red-500 hover:bg-red-100 rounded-lg transition-colors"
                                    title="Riprova a caricare"
                                >
                                    <RefreshCw className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                        {hasError && (
                            <div className="flex items-start gap-2 mt-2 text-[10px] text-red-500 font-medium bg-red-50 dark:bg-red-900/10 p-2 rounded-md leading-tight">
                                <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                                <span>Video limitato dal proprietario o da YouTube. Prova un altro link.</span>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-4 bg-gray-50 dark:bg-zinc-800/50 p-3 rounded-xl border border-gray-100 dark:border-zinc-800">
                        <button
                            type="button"
                            onClick={() => setIsPlaying(!isPlaying)}
                            disabled={!videoId || hasError}
                            className={`
                                w-10 h-10 rounded-full flex items-center justify-center transition-all
                                ${videoId && !hasError
                                    ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-none' 
                                    : 'bg-gray-200 dark:bg-zinc-700 text-gray-400 cursor-not-allowed'
                                }
                            `}
                        >
                            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 ml-0.5 fill-current" />}
                        </button>

                        <div className="flex-1 space-y-1">
                             <div className="flex items-center justify-between text-[10px] text-gray-500 font-medium">
                                <div className="flex items-center gap-1"><Volume2 className="w-3 h-3" /> Mix</div>
                                <span>{volume}%</span>
                             </div>
                             <input 
                                type="range" 
                                min="0" 
                                max="100" 
                                value={volume}
                                onChange={(e) => setVolume(Number(e.target.value))}
                                className="w-full h-1 bg-gray-200 dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                             />
                        </div>
                    </div>

                    <div className="pt-2 border-t border-gray-100 dark:border-zinc-800">
                         <p className="text-[10px] text-gray-400 mb-2">Preset Sicuri:</p>
                         <div className="flex flex-wrap gap-2">
                             {presets.map(preset => (
                                 <button 
                                    type="button"
                                    key={preset.url}
                                    onClick={() => setUrl(preset.url)}
                                    className="px-2 py-1 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded text-[10px] text-gray-600 dark:text-gray-400 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                                 >
                                    {preset.name}
                                 </button>
                             ))}
                         </div>
                    </div>
                </div>
            </div>
        </>
      )}

      {/* Explicit Iframe Rendering for robustness */}
      <div className="absolute w-[1px] h-[1px] opacity-0 pointer-events-none overflow-hidden bottom-0 right-0">
         {videoId && (
             <iframe
                ref={iframeRef}
                id="lumina-bg-player"
                width="100%"
                height="100%"
                src={getIframeSrc(videoId)}
                title="Background Music"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                style={{ pointerEvents: 'none' }}
                referrerPolicy="no-referrer"
             />
         )}
      </div>
    </div>
  );
};

export default MusicPlayer;
