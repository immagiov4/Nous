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
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const visibleText = useMemo(() => {
    const trimmedText = text?.trim();
    return trimmedText ? normalizeReasoningText(trimmedText) : undefined;
  }, [text]);
  const hasContent = Boolean(visibleText);

  // Drive a constant-velocity scroll loop while content is streaming. The loop
  // is decoupled from text updates: it advances by a fixed pixel-per-second
  // delta every animation frame and pauses naturally when it reaches the
  // bottom. New content extends scrollHeight, which the loop will gradually
  // catch up to without ever snapping.
  useEffect(() => {
    if (!hasContent) {
      return;
    }

    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }

    let frameId: number | null = null;
    let lastTimestamp: number | null = null;
    let accumulatedRemainder = 0;

    const step = (timestamp: number) => {
      if (lastTimestamp === null) {
        lastTimestamp = timestamp;
        frameId = window.requestAnimationFrame(step);
        return;
      }

      const elapsedSeconds = Math.min((timestamp - lastTimestamp) / 1000, 0.1);
      lastTimestamp = timestamp;

      const maxScrollTop = Math.max(viewport.scrollHeight - viewport.clientHeight, 0);
      if (maxScrollTop > viewport.scrollTop) {
        const advance = SCROLL_VELOCITY_PX_PER_SECOND * elapsedSeconds + accumulatedRemainder;
        const integerAdvance = Math.floor(advance);
        accumulatedRemainder = advance - integerAdvance;
        if (integerAdvance > 0) {
          viewport.scrollTop = Math.min(viewport.scrollTop + integerAdvance, maxScrollTop);
        }
      } else {
        accumulatedRemainder = 0;
      }

      frameId = window.requestAnimationFrame(step);
    };

    frameId = window.requestAnimationFrame(step);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
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
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-16 bg-gradient-to-t from-paper-light via-paper-light/92 to-transparent dark:from-paper-dark dark:via-paper-dark/86" />
      <div
        ref={scrollViewportRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3"
        style={{
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 7%, black 90%, transparent 100%)',
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 7%, black 90%, transparent 100%)',
        }}
      >
        <StreamingMarkdownRenderer
          content={visibleText}
          isStreaming
          isDarkMode={isDarkMode}
          className="prose-sm max-w-none leading-7 opacity-75 prose-p:my-2 prose-p:text-gray-600 prose-strong:text-gray-700 dark:prose-p:text-zinc-300 dark:prose-strong:text-zinc-100"
        />
      </div>
    </div>
  );
}
