import { Loader2 } from 'lucide-react';

interface LoadingScreenProps {
  message: string;
  subMessage?: string;
}

const LoadingScreen = ({ message, subMessage }: LoadingScreenProps) => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-1000 bg-paper-light dark:bg-paper-dark transition-colors overflow-hidden relative">
      
      {/* Dynamic Background Glow */}
      <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
        <div className="absolute w-[500px] h-[500px] bg-orange-400/5 dark:bg-orange-500/5 rounded-full blur-[100px] animate-pulse" style={{ animationDuration: '4s' }} />
        <div className="absolute w-[300px] h-[300px] bg-amber-200/10 dark:bg-amber-600/10 rounded-full blur-[60px] animate-pulse" style={{ animationDuration: '3s', animationDelay: '1s' }} />
      </div>

      {/* Core Orbital Animation */}
      <div className="relative mb-12 flex items-center justify-center w-40 h-40">
        
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
        <div className="absolute inset-0 m-auto w-12 h-12 bg-gradient-to-tr from-orange-400 to-amber-300 dark:from-orange-600 dark:to-amber-500 rounded-full blur-md animate-pulse" style={{ animationDuration: '2s' }} />
        
        {/* Static Central Icon/Spinner Container */}
        <div className="relative z-10 bg-white/90 dark:bg-paper-surface/90 backdrop-blur-sm p-4 rounded-full shadow-[0_0_30px_rgba(251,146,60,0.15)] dark:shadow-[0_0_30px_rgba(234,88,12,0.15)] border border-orange-100/50 dark:border-zinc-700/50">
          <Loader2 className="w-6 h-6 text-orange-600 dark:text-orange-400 animate-spin" />
        </div>
      </div>

      {/* Typography */}
      <div className="relative z-10 flex flex-col items-center">
        <h2 className="text-2xl sm:text-3xl font-serif text-gray-800 dark:text-gray-100 mb-4 drop-shadow-sm">
          {message}
        </h2>
        {subMessage && (
          <div className="flex items-center justify-center gap-3">
            <div className="flex items-center gap-1 opacity-70">
              <span className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 max-w-md font-medium tracking-wide">
              {subMessage}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default LoadingScreen;
