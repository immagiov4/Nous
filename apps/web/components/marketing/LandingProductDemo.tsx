import { useEffect, useRef, useState } from 'react';
import { getAppLocale } from '../../i18n/uiMessages.ts';
import { DEMO_STAGE_SEGMENTS, type DemoStage } from './landingDemoTimeline.ts';

export type { DemoStage } from './landingDemoTimeline.ts';

interface LandingProductDemoProps {
  activeStage?: DemoStage;
}

const COMPACT_BREAKPOINT = 832;
const VIDEO_ROOT = '/marketing/demos';
const SEGMENT_END_TOLERANCE_SECONDS = 0.3;

const getDemoVideoSource = (isCompact: boolean): string =>
  `${VIDEO_ROOT}/journey-${isCompact ? 'compact' : 'wide'}-${getAppLocale()}.mp4`;

export default function LandingProductDemo({
  activeStage = 'lesson',
}: LandingProductDemoProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isCompact] = useState(() => window.innerWidth <= COMPACT_BREAKPOINT);
  const [isInView, setIsInView] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(([entry]) => setIsInView(entry.isIntersecting), {
      threshold: 0.05,
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const seekToActiveStage = () => {
      video.currentTime = DEMO_STAGE_SEGMENTS[activeStage].startSeconds;
    };
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seekToActiveStage();
    } else {
      video.addEventListener('loadedmetadata', seekToActiveStage, { once: true });
    }

    return () => video.removeEventListener('loadedmetadata', seekToActiveStage);
  }, [activeStage]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const syncPlayback = () => {
      const shouldPlay = isInView && document.visibilityState === 'visible';
      if (shouldPlay) {
        void video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    };

    syncPlayback();
    video.addEventListener('canplay', syncPlayback);
    video.addEventListener('seeked', syncPlayback);
    document.addEventListener('visibilitychange', syncPlayback);
    return () => {
      video.removeEventListener('canplay', syncPlayback);
      video.removeEventListener('seeked', syncPlayback);
      document.removeEventListener('visibilitychange', syncPlayback);
    };
  }, [isInView]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const restartActiveSegment = () => {
      const segment = DEMO_STAGE_SEGMENTS[activeStage];
      if (video.currentTime >= segment.endSeconds - SEGMENT_END_TOLERANCE_SECONDS) {
        video.currentTime = segment.startSeconds;
      }
    };

    video.addEventListener('timeupdate', restartActiveSegment);
    video.addEventListener('ended', restartActiveSegment);
    return () => {
      video.removeEventListener('timeupdate', restartActiveSegment);
      video.removeEventListener('ended', restartActiveSegment);
    };
  }, [activeStage]);

  return (
    <div
      ref={containerRef}
      className="marketing-product-demo marketing-product-video"
      aria-hidden="true"
      inert
      style={{
        aspectRatio: isCompact ? '390 / 750' : '1200 / 800',
        position: 'relative',
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        preload="metadata"
        src={getDemoVideoSource(isCompact)}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
