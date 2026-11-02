import type { SourcePreparationProgress } from '@shared/sourcePreparation';
import sourceShelfPalettes from '@shared/sourceShelfPalettes.json';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pushNousDebugTrace } from '../../services/core/debugTrace.ts';
import { useShouldAnimate } from '../../utils/motion/index.ts';

type SourceState = NonNullable<SourcePreparationProgress['documents']>[number]['state'];
const ART_ROOT = '/source-shelf/preparation-';
export const PREPARATION_PALETTE = Object.keys(
  sourceShelfPalettes
) as (keyof typeof sourceShelfPalettes)[];
type PreparationColor = (typeof PREPARATION_PALETTE)[number];

const POSTER: Record<SourceState, string> = {
  idle: 'closed',
  reading: 'reading',
  done: 'complete',
  error: 'closed',
};
export const sourcePreparationPoster = (state: SourceState, color: PreparationColor) =>
  `${ART_ROOT}${color}-${POSTER[state]}.webp`;

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

type Clip = 'reading' | 'search' | 'complete';

// Every clip starts and ends on the same rendered rest pose, so a clip boundary never cuts
// mid-gesture: completion lets the current reading pass end before the book closes.
function PreparationVideo({
  completing,
  color,
  onPlaying,
}: {
  readonly completing: boolean;
  readonly color: PreparationColor;
  readonly onPlaying: () => void;
}) {
  const [clip, setClip] = useState<Clip>('reading');
  const [settled, setSettled] = useState(false);
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);
  const fallbackRecorded = useRef(false);
  const showFallback = useCallback(
    (video: HTMLVideoElement, reason: string, cause?: number | string) => {
      if (fallbackRecorded.current) return;
      fallbackRecorded.current = true;
      pushNousDebugTrace('source-shelf:video-fallback', {
        clip: video.dataset.phase,
        color,
        reason,
        cause,
      });
      setFailed(true);
    },
    [color]
  );
  const poster = sourcePreparationPoster(completing ? 'done' : 'reading', color);
  // Browsers paint the poster while a new clip source loads. Decode the boundary and final
  // stills up front so a clip switch never shows a stale (closed) poster for a frame.
  useEffect(() => {
    for (const state of ['reading', 'done'] as const)
      new Image().src = sourcePreparationPoster(state, color);
  }, [color]);
  const finishClip = () => {
    if (clip === 'complete') setSettled(true);
    else setClip(completing ? 'complete' : 'search');
  };

  const bindVideo = useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video) return;
      let current = true;
      const synchronize = () => {
        if (document.visibilityState === 'hidden') video.pause();
        else
          void video.play().catch(error => {
            if (current && error.name !== 'AbortError')
              showFallback(
                video,
                'playback-rejected',
                error instanceof DOMException ? error.name : 'Error'
              );
          });
      };
      synchronize();
      document.addEventListener('visibilitychange', synchronize);
      return () => {
        current = false;
        document.removeEventListener('visibilitychange', synchronize);
        video.pause();
      };
    },
    [showFallback]
  );

  if (failed || settled) return <img src={poster} alt="" />;
  return (
    <video
      ref={bindVideo}
      src={`${ART_ROOT}${color}-${clip}.webm`}
      // Switch to the rest-pose poster once playback hides it, never at the clip switch itself.
      poster={sourcePreparationPoster(started ? 'reading' : 'idle', color)}
      autoPlay
      muted
      playsInline
      loop={clip === 'search' && !completing}
      preload="auto"
      data-phase={clip}
      onPlaying={() => {
        setStarted(true);
        onPlaying();
      }}
      onLoadedData={event => {
        const video = event.currentTarget;
        if (!hasTransparentFrame(video)) {
          showFallback(video, 'alpha-unsupported');
          return;
        }
        if (document.visibilityState === 'hidden') return;
        const loadedSource = video.currentSrc;
        void video.play().catch(error => {
          if (
            error.name !== 'AbortError' &&
            video.isConnected &&
            video.currentSrc === loadedSource &&
            video.src === loadedSource
          )
            showFallback(
              video,
              'playback-rejected',
              error instanceof DOMException ? error.name : 'Error'
            );
        });
      }}
      onError={event =>
        showFallback(event.currentTarget, 'media-error', event.currentTarget.error?.code)
      }
      onEnded={finishClip}
    />
  );
}

/** Decorative playback follows document state; it never completes or delays preparation. */
export default function SourceBookPreparationArt({
  state,
  color,
  animateReading = true,
}: {
  readonly state: SourceState;
  readonly color: PreparationColor;
  readonly animateReading?: boolean;
}) {
  const shouldAnimate = useShouldAnimate();
  const [hasPlayed, setHasPlayed] = useState(false);
  // A new reading run gets a fresh player; a run that ended keeps its settled still.
  const [run, setRun] = useState({ state, count: 0 });
  if (run.state !== state) setRun({ state, count: run.count + (state === 'reading' ? 1 : 0) });
  // A book that was visibly reading never snaps shut: whatever state follows (done, error or
  // another source taking the stage), it finishes its pass and closes. The closing clip's last
  // frame is pixel-identical to the closed still.
  const animate = shouldAnimate && (state === 'reading' ? animateReading : hasPlayed);
  return (
    <div className="source-book-preparation" aria-hidden="true" inert>
      {animate ? (
        <PreparationVideo
          key={run.count}
          completing={state !== 'reading'}
          color={color}
          onPlaying={() => setHasPlayed(true)}
        />
      ) : (
        <img src={sourcePreparationPoster(state, color)} alt="" />
      )}
    </div>
  );
}
