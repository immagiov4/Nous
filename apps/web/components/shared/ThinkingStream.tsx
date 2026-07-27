import { useEffect, useMemo, useRef } from 'react';
import StreamingMarkdownRenderer from './StreamingMarkdownRenderer.tsx';

interface ThinkingStreamProps {
  readonly className?: string;
  readonly isDarkMode: boolean;
  readonly text?: string;
}

// Constant scroll velocity in pixels per second. Slow & predictable so the
// reader has time to glance at lines without chasing the latest token.
const SCROLL_VELOCITY_PX_PER_SECOND = 42;
const SCROLL_START_BUFFER_PX = 120;
const SCROLL_STOP_BUFFER_PX = 28;

const isEscapedBackslashSequence = (text: string, slashIndex: number): boolean => {
  let backslashCount = 0;
  let cursor = slashIndex - 1;

  while (cursor >= 0 && text[cursor] === '\\') {
    backslashCount += 1;
    cursor -= 1;
  }

  return backslashCount % 2 === 1;
};

const restoreLiteralWhitespaceTokens = (text: string): string => {
  let normalized = '';

  for (let index = 0; index < text.length; ) {
    if (text[index] === '\\' && !isEscapedBackslashSequence(text, index)) {
      const nextSlice = text.slice(index, index + 4);
      if (nextSlice === String.raw`\r\n`) {
        normalized += '\n';
        index += 4;
        continue;
      }

      const nextCharacter = text[index + 1];
      if (nextCharacter === 'n' || nextCharacter === 'r') {
        normalized += '\n';
        index += 2;
        continue;
      }

      if (nextCharacter === 't') {
        normalized += '  ';
        index += 2;
        continue;
      }
    }

    normalized += text[index];
    index += 1;
  }

  return normalized;
};

const findHeadingStartIndex = (line: string): number => {
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] !== '#') {
      continue;
    }

    const previousCharacter = line[index - 1];
    if (previousCharacter === '#') {
      continue;
    }

    let headingEnd = index;
    while (headingEnd < line.length && line[headingEnd] === '#') {
      headingEnd += 1;
    }

    if (headingEnd === index || headingEnd - index > 6 || line[headingEnd] !== ' ') {
      continue;
    }

    return index;
  }

  return -1;
};

const insertHeadingBreaks = (text: string): string =>
  text
    .split('\n')
    .map(line => {
      const headingStartIndex = findHeadingStartIndex(line);
      if (headingStartIndex <= 0) {
        return line;
      }

      const prefix = line.slice(0, headingStartIndex).trimEnd();
      const heading = line.slice(headingStartIndex);
      return `${prefix}\n\n${heading}`;
    })
    .join('\n');

const normalizeReasoningText = (text: string): string =>
  insertHeadingBreaks(
    restoreLiteralWhitespaceTokens(text)
      .replaceAll(/([.!?])\s*(\*\*[^*\n][^*\n]{1,100}\*\*)(?=\s|$)/g, '$1\n\n$2')
      .replaceAll(
        /([.!?])\s*([A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ]+(?:\s+[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ]+){1,5})(?=\n)/g,
        '$1\n\n$2'
      )
  );

export default function ThinkingStream({ className = '', isDarkMode, text }: ThinkingStreamProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const visibleText = useMemo(() => {
    const trimmedText = text?.trim();
    return trimmedText ? normalizeReasoningText(trimmedText) : undefined;
  }, [text]);
  const hasContent = Boolean(visibleText);

  // GPU-friendly buffered scroll. We wait for enough generated content before
  // moving, then consume that scrollable buffer at a fixed pace. If generation
  // slows down, the stream pauses before it reaches the live token edge and
  // resumes only after the buffer has refilled, avoiding tiny stop/start jolts.
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
    let isScrolling = false;

    const step = (timestamp: number) => {
      if (lastTimestamp === null) {
        lastTimestamp = timestamp;
        frameId = globalThis.window.requestAnimationFrame(step);
        return;
      }

      const elapsedSeconds = Math.min((timestamp - lastTimestamp) / 1000, 0.1);
      lastTimestamp = timestamp;

      const maxOffset = Math.max(track.scrollHeight - viewport.clientHeight, 0);
      const bufferedScrollPx = maxOffset - offsetY;
      if (!isScrolling && bufferedScrollPx >= SCROLL_START_BUFFER_PX) {
        isScrolling = true;
      }

      if (isScrolling && bufferedScrollPx <= SCROLL_STOP_BUFFER_PX) {
        isScrolling = false;
      }

      if (isScrolling && offsetY < maxOffset) {
        offsetY = Math.min(offsetY + SCROLL_VELOCITY_PX_PER_SECOND * elapsedSeconds, maxOffset);
        track.style.transform = `translate3d(0, ${-offsetY}px, 0)`;
      }

      frameId = globalThis.window.requestAnimationFrame(step);
    };

    frameId = globalThis.window.requestAnimationFrame(step);

    return () => {
      if (frameId !== null) {
        globalThis.window.cancelAnimationFrame(frameId);
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
