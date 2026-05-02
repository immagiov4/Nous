// fallow-ignore-file unused-files
import { Loader2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useState } from 'react';
import ThinkingStream from './ThinkingStream.tsx';

interface LoadingScreenProps {
  isDarkMode?: boolean;
  message: string;
  reasoningText?: string;
  subMessage?: string;
}

const LoadingScreen = ({
  isDarkMode = false,
  message,
  reasoningText,
  subMessage,
}: LoadingScreenProps) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const hasReasoningText = Boolean(reasoningText?.trim());

  useLayoutEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousHtmlOverscroll = html.style.overscrollBehavior;
    const previousBodyOverscroll = body.style.overscrollBehavior;

    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'none';
    body.style.overscrollBehavior = 'none';
    window.scrollTo(0, 0);
    html.scrollTop = 0;
    body.scrollTop = 0;

    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
      html.style.overscrollBehavior = previousHtmlOverscroll;
      body.style.overscrollBehavior = previousBodyOverscroll;
    };
  }, []);

  useEffect(() => {
    setElapsedSeconds(0);
    const intervalId = window.setInterval(() => {
      setElapsedSeconds(seconds => seconds + 1);
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const waitingHint =
    elapsedSeconds >= 120
      ? 'Sto ancora lavorando: per corsi lunghi puo volerci qualche minuto.'
      : elapsedSeconds >= 35
        ? 'Operazione ancora in corso, non e un blocco.'
        : null;

  return (
    <div className="relative flex flex-1 flex-col items-center justify-start overflow-hidden bg-paper-light p-4 pt-[max(1rem,env(safe-area-inset-top))] text-center transition-colors animate-in fade-in duration-1000 sm:justify-center sm:p-8 dark:bg-paper-dark">
      {/* Dynamic Background Glow */}
      <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
        <div
          className="absolute w-[500px] h-[500px] bg-orange-400/5 dark:bg-orange-500/5 rounded-full blur-[100px] animate-pulse"
          style={{ animationDuration: '4s' }}
        />
        <div
          className="absolute w-[300px] h-[300px] bg-amber-200/10 dark:bg-amber-600/10 rounded-full blur-[60px] animate-pulse"
          style={{ animationDuration: '3s', animationDelay: '1s' }}
        />
      </div>

      {/* Core Orbital Animation */}
      <div
        className={`relative mb-6 mt-2 flex h-28 w-28 items-center justify-center sm:mb-12 sm:mt-0 sm:h-40 sm:w-40 ${
          hasReasoningText ? 'opacity-35' : ''
        }`}
      >
        {/* Orbits */}
        <div className="absolute inset-0 border border-orange-200/50 dark:border-orange-500/30 rounded-full animate-[spin_8s_linear_infinite]" />
        <div className="absolute inset-4 border border-orange-300/30 dark:border-orange-400/20 rounded-full animate-[spin_12s_linear_infinite_reverse]" />
        <div className="absolute -inset-4 border border-orange-100/30 dark:border-orange-500/10 rounded-full animate-[spin_18s_linear_infinite]" />

        {/* Floating Particles / Nodes */}
        <div className="absolute inset-0 animate-[spin_8s_linear_infinite]">
          <div className="w-2 h-2 bg-orange-400 rounded-full shadow-[0_0_8px_rgba(251,146,60,0.8)] absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2" />
        </div>
        <div className="absolute inset-4 animate-[spin_12s_linear_infinite_reverse]">
          <div className="w-1.5 h-1.5 bg-amber-500 rounded-full shadow-[0_0_6px_rgba(245,158,11,0.8)] absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2" />
        </div>
        <div className="absolute -inset-4 animate-[spin_18s_linear_infinite]">
          <div className="w-1 h-1 bg-orange-300 rounded-full shadow-[0_0_4px_rgba(253,186,116,0.8)] absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2" />
        </div>
        {/* Central Glowing Core */}
        <div
          className="absolute inset-0 m-auto w-12 h-12 bg-gradient-to-tr from-orange-400 to-amber-300 dark:from-orange-600 dark:to-amber-500 rounded-full blur-md animate-pulse"
          style={{ animationDuration: '2s' }}
        />

        {/* Static Central Icon/Spinner Container */}
        <div className="relative z-10 bg-white/90 dark:bg-paper-surface/90 backdrop-blur-sm p-4 rounded-full shadow-[0_0_30px_rgba(251,146,60,0.15)] dark:shadow-[0_0_30px_rgba(234,88,12,0.15)] border border-orange-100/50 dark:border-zinc-700/50">
          <Loader2 className="w-6 h-6 text-orange-600 dark:text-orange-400 animate-spin" />
        </div>
      </div>

      {/* Typography */}
      <div className="relative z-10 flex w-full min-h-0 flex-1 flex-col items-stretch">
        <h2 className="mb-3 text-lg font-serif text-gray-800 drop-shadow-sm sm:mb-4 sm:text-3xl dark:text-gray-100">
          {message}
        </h2>
        {subMessage && (
          <div className="hidden flex-col items-center justify-center gap-3 sm:flex">
            <div className="flex items-center justify-center gap-3">
              <div className="flex items-center gap-1 opacity-70">
                <span
                  className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-bounce"
                  style={{ animationDelay: '0ms' }}
                />
                <span
                  className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-bounce"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-bounce"
                  style={{ animationDelay: '300ms' }}
                />
              </div>
              <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 max-w-md font-medium tracking-wide">
                {subMessage}
              </p>
            </div>
            {waitingHint ? (
              <p className="max-w-md text-xs font-medium text-gray-500 dark:text-gray-400">
                {waitingHint}
              </p>
            ) : null}
          </div>
        )}
        <ThinkingStream
          text={reasoningText}
          isDarkMode={isDarkMode}
          className="mt-4 min-h-[14rem] h-[58dvh] max-h-[36rem] w-full max-w-3xl flex-1 self-center text-left sm:mt-6 sm:h-[68vh] sm:max-h-[52rem]"
        />
      </div>
    </div>
  );
};

// fallow-ignore-next-line unused-exports — imported by App.tsx as default
export default LoadingScreen;
