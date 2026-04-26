import { useEffect, useMemo, useRef } from 'react';
import StreamingMarkdownRenderer from './StreamingMarkdownRenderer.tsx';

interface ThinkingStreamProps {
  className?: string;
  isDarkMode: boolean;
  text?: string;
}

// Constant scroll velocity in pixels per second. Slow & predictable so the
// reader has time to glance at lines without chasing the latest token.
const SCROLL_VELOCITY_PX_PER_SECOND = 28;

const normalizeReasoningText = (text: string): string =>
  text
    .replace(/([^\n])\s*(#{1,6}\s)/g, '$1\n\n$2')
    .replace(/([.!?])\s*(\*\*[^*\n][^*\n]{1,100}\*\*)(?=\s|$)/g, '$1\n\n$2')
    .replace(
      /([.!?])\s*([A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ]+(?:\s+[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ]+){1,5})(?=\n)/g,
      '$1\n\n$2'
    );

export default function ThinkingStream({ className = '', isDarkMode, text }: ThinkingStreamProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const visibleText = useMemo(() => {
    const trimmedText = text?.trim();
    return trimmedText ? normalizeReasoningText(trimmedText) : undefined;
  }, [text]);
  const hasContent = Boolean(visibleText);

  // GPU-friendly constant-velocity scroll. Instead of mutating `scrollTop`
  // (which triggers layout/paint each frame and stutters on Firefox mobile),
  // we translate an inner track via `transform: translate3d(...)` so the
  // browser can keep the animation on the compositor.
  useEffect(() => {
    if (!hasContent) {
      return;
    }

    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) {
      return;
    }

    let frameId: number | null = null;
    let lastTimestamp: number | null = null;
    let offsetY = 0;

    const step = (timestamp: number) => {
      if (lastTimestamp === null) {
        lastTimestamp = timestamp;
        frameId = window.requestAnimationFrame(step);
        return;
      }

      const elapsedSeconds = Math.min((timestamp - lastTimestamp) / 1000, 0.1);
      lastTimestamp = timestamp;

      const maxOffset = Math.max(track.scrollHeight - viewport.clientHeight, 0);
      if (offsetY < maxOffset) {
        offsetY = Math.min(offsetY + SCROLL_VELOCITY_PX_PER_SECOND * elapsedSeconds, maxOffset);
        track.style.transform = `translate3d(0, ${-offsetY}px, 0)`;
      }

      frameId = window.requestAnimationFrame(step);
    };

    frameId = window.requestAnimationFrame(step);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      track.style.transform = '';
    };
  }, [hasContent]);

  if (!visibleText) {
    return null;
  }

  return (
    <div
      className={`relative flex min-h-0 w-full flex-col overflow-hidden py-2 ${className}`}
      aria-live="polite"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-12 bg-gradient-to-b from-paper-light via-paper-light/88 to-transparent dark:from-paper-dark dark:via-paper-dark/82" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-paper-light via-paper-light/92 to-transparent dark:from-paper-dark dark:via-paper-dark/86" />
      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-hidden px-3"
        style={{
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 7%, black 88%, transparent 100%)',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 7%, black 88%, transparent 100%)',
        }}
      >
        <div
          ref={trackRef}
          className="absolute inset-x-0 top-0 px-3"
          style={{ willChange: 'transform', transform: 'translate3d(0, 0, 0)' }}
        >
          <StreamingMarkdownRenderer
            content={visibleText}
            isStreaming
            isDarkMode={isDarkMode}
            className="prose-sm max-w-none leading-7 opacity-75 prose-p:my-2 prose-p:text-gray-600 prose-strong:text-gray-700 dark:prose-p:text-zinc-300 dark:prose-strong:text-zinc-100"
          />
        </div>
      </div>
    </div>
  );
}
