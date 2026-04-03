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

const MusicPlayer = ({
  url,
  setUrl,
  isPlaying,
  setIsPlaying,
  volume,
  setVolume,
}: MusicPlayerProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const inputId = useId();
  const presets = [
    {
      name: 'Anti-anxiety',
      url: 'https://www.youtube.com/watch?v=8p7LwCBgpCE&list=PLeAQnc67cxxRtrDpUavOpv8jzwcFRD0FV',
    },
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
    const id = match && match[2].length === 11 ? match[2] : null;

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
        tag.src = 'https://www.youtube.com/iframe_api';
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
              if (event.data === 1) {
                // Playing
                setIsPlaying(true);
                setHasError(false);
              }
              if (event.data === 2) setIsPlaying(false); // Paused
            },
            onError: event => {
              console.warn('YouTube Player Error:', event.data);
              // Errors: 100/101/150 are embed restrictions, 153 means missing client identity/referrer.
              if (
                event.data === 100 ||
                event.data === 101 ||
                event.data === 150 ||
                event.data === 153
              ) {
                setHasError(true);
                setIsPlaying(false);
              }
            },
          },
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

  const getPlayerOrigin = () => {
    if (typeof window === 'undefined') return null;

    const { origin, protocol } = window.location;
    if ((protocol === 'http:' || protocol === 'https:') && origin && origin !== 'null') {
      return origin;
    }

    return null;
  };

  // Keep the embed compatible with YouTube's API requirements while still using the privacy-enhanced host.
  const getIframeSrc = (id: string) => {
    const params = new URLSearchParams({
      enablejsapi: '1',
      autoplay: '0',
      controls: '0',
      disablekb: '1',
      fs: '0',
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

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`
            rounded-full border p-2 transition-colors
            ${
              isOpen || isPlaying
                ? 'border-gray-300 bg-gray-100 text-gray-700 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-zinc-200'
                : 'bg-transparent border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800'
            }
            ${hasError ? 'border-red-200 bg-red-50 text-red-500 dark:border-red-900/50 dark:bg-red-950/20' : ''}
        `}
        title="Musica di sottofondo (YouTube)"
      >
        <Headphones className="h-5 w-5" />
      </button>

      {isOpen && (
        <>
          <button
            type="button"
            aria-label="Chiudi pannello musica"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute right-0 top-[calc(100%+0.75rem)] z-50 w-80 overflow-hidden rounded-[2rem] border border-gray-200 bg-white px-5 pb-5 pt-4 shadow-[0_12px_30px_-8px_rgba(15,23,42,0.12),0_28px_60px_-22px_rgba(15,23,42,0.22)] dark:border-zinc-600/80 dark:bg-stone-700 dark:shadow-[0_16px_34px_-14px_rgba(0,0,0,0.35),0_30px_60px_-24px_rgba(0,0,0,0.38)]">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-zinc-200">
                <Music className="w-4 h-4" />
                <span>Audio ambiente</span>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-gray-400 transition-colors hover:text-gray-700 dark:hover:text-zinc-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label htmlFor={inputId} className="mb-1 block text-xs font-semibold text-gray-500">
                  YouTube Link
                </label>
                <div className="flex gap-2">
                  <input
                    id={inputId}
                    type="text"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder="incolla link YouTube..."
                    className={`flex-1 rounded-[1.15rem] border bg-white px-3 py-2 text-xs text-gray-800 outline-none transition-colors focus:border-gray-400 dark:bg-stone-800 dark:text-gray-100 dark:focus:border-zinc-500 ${hasError ? 'border-red-300 ring-1 ring-red-100' : 'border-gray-200 dark:border-zinc-500/80'}`}
                  />
                  {hasError && (
                    <button
                      type="button"
                      onClick={handleRetry}
                      className="rounded-[1.15rem] bg-red-50 p-2 text-red-500 transition-colors hover:bg-red-100"
                      title="Riprova a caricare"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {hasError && (
                  <div className="mt-2 flex items-start gap-2 rounded-[1.15rem] bg-red-50 p-2 text-[10px] font-medium leading-tight text-red-500 dark:bg-red-900/10">
                    <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    <span>Video limitato dal proprietario o da YouTube. Prova un altro link.</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-4 rounded-[1.5rem] border border-gray-200 bg-white p-3 dark:border-zinc-500/80 dark:bg-stone-800">
                <button
                  type="button"
                  onClick={() => setIsPlaying(!isPlaying)}
                  disabled={!videoId || hasError}
                  className={`
                                flex h-10 w-10 items-center justify-center rounded-full transition-colors
                                ${
                                  videoId && !hasError
                                    ? 'bg-gray-900 text-white hover:bg-black dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white'
                                    : 'bg-gray-200 dark:bg-zinc-700 text-gray-400 cursor-not-allowed'
                                }
                            `}
                >
                  {isPlaying ? (
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
                    <span>{volume}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={e => setVolume(Number(e.target.value))}
                    className="h-1 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-gray-700 dark:bg-zinc-700 dark:accent-zinc-300"
                  />
                </div>
              </div>

              <div className="border-t border-gray-200/80 pt-2 dark:border-zinc-700/80">
                <p className="mb-2 text-[10px] text-gray-400">Preset Sicuri:</p>
                <div className="flex flex-wrap gap-2">
                  {presets.map(preset => (
                    <button
                      type="button"
                      key={preset.url}
                      onClick={() => setUrl(preset.url)}
                      className="rounded-[1rem] border border-gray-200 bg-white px-2 py-1 text-[10px] text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-500/80 dark:bg-stone-800 dark:text-gray-300 dark:hover:border-zinc-400 dark:hover:text-white"
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
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
      </div>
    </div>
  );
};

export default MusicPlayer;
