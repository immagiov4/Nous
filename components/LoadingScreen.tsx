import { Loader2 } from 'lucide-react';

interface LoadingScreenProps {
  message: string;
  subMessage?: string;
}

const LoadingScreen = ({ message, subMessage }: LoadingScreenProps) => {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-500 bg-paper-light dark:bg-paper-dark transition-colors">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-orange-200 dark:bg-orange-900 rounded-full opacity-20 animate-ping"></div>
        <div className="relative bg-white dark:bg-paper-surface p-4 rounded-full shadow-lg border border-orange-100 dark:border-zinc-700/80">
          <Loader2 className="w-8 h-8 text-orange-600 dark:text-orange-400 animate-spin" />
        </div>
      </div>
      <h2 className="text-2xl font-serif text-gray-800 dark:text-gray-100 mb-2">{message}</h2>
      {subMessage && <p className="text-gray-500 dark:text-gray-400 max-w-md">{subMessage}</p>}
    </div>
  );
};

export default LoadingScreen;
