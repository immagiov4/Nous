import type { SourcePreparationProgress } from '@shared/sourcePreparation';
import { useCallback, useState } from 'react';
import { useShouldAnimate } from '../../utils/motion/index.ts';

type SourceState = NonNullable<SourcePreparationProgress['documents']>[number]['state'];
const ART_ROOT = '/source-shelf/preparation-';

const POSTER: Record<SourceState, string> = {
  idle: 'closed',
  reading: 'reading',
  done: 'complete',
  error: 'closed',
};
const posterFor = (state: SourceState) => `${ART_ROOT}${POSTER[state]}.webp`;

// Some browsers decode VP9 without its alpha plane. Keep the approved static art
// instead of displaying an opaque rectangle over the shelf in those browsers.
function hasTransparentFrame(video: HTMLVideoElement): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) return false;
  context.drawImage(video, 0, 0, 1, 1, 0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3] === 0;
}

function PreparationVideo({
  completing,
  onPlaying,
}: {
  readonly completing: boolean;
  readonly onPlaying: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [settled, setSettled] = useState(false);
  const [failed, setFailed] = useState(false);
  const readingClip = searching ? 'search' : 'reading';
  const clip = completing ? 'complete' : readingClip;
  const poster = posterFor(completing ? 'done' : 'reading');

  const bindVideo = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    let current = true;
    const synchronize = () => {
      if (document.visibilityState === 'hidden') video.pause();
      else
        void video.play().catch(() => {
          if (current) setFailed(true);
        });
    };
    synchronize();
    document.addEventListener('visibilitychange', synchronize);
    return () => {
      current = false;
      document.removeEventListener('visibilitychange', synchronize);
      video.pause();
    };
  }, []);

  if (failed || settled) return <img src={poster} alt="" />;
  return (
    <video
      key={clip}
      ref={bindVideo}
      src={`${ART_ROOT}${clip}.webm`}
      poster={posterFor(searching || completing ? 'reading' : 'idle')}
      autoPlay
      muted
      playsInline
      loop={searching && !completing}
      preload="auto"
      data-phase={clip}
      onPlaying={onPlaying}
      onLoadedData={event => {
        if (!hasTransparentFrame(event.currentTarget)) setFailed(true);
      }}
      onError={() => setFailed(true)}
      onEnded={() => (completing ? setSettled(true) : setSearching(true))}
    />
  );
}

/** Decorative playback follows document state; it never completes or delays preparation. */
export default function SourceBookPreparationArt({ state }: { readonly state: SourceState }) {
  const shouldAnimate = useShouldAnimate();
  const [hasPlayed, setHasPlayed] = useState(false);
  const animate = shouldAnimate && (state === 'reading' || (state === 'done' && hasPlayed));
  return (
    <div className="source-book-preparation" aria-hidden="true" inert>
      {animate ? (
        <PreparationVideo
          key={state}
          completing={state === 'done'}
          onPlaying={() => setHasPlayed(true)}
        />
      ) : (
        <img src={posterFor(state)} alt="" />
      )}
    </div>
  );
}
