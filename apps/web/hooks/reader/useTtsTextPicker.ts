import { type RefObject, useCallback, useEffect, useState } from 'react';
import {
  buildReadableTextElements,
  type ReadableTextElement,
} from '../../utils/reader/readingText.ts';

const OVERLAY_HORIZONTAL_INSET_PX = 6;

interface TtsTextPickerOverlayRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface UseTtsTextPickerParams {
  chunkTexts: string[];
  contentRef: RefObject<HTMLDivElement | null>;
  onSelectChunk: (chunkIndex: number) => void;
}

interface ReadableChunkMatch extends ReadableTextElement {
  chunkIndexes: number[];
}

const normalizeText = (text: string): string => text.replace(/\s+/gu, ' ').trim();

const findMatchingChunkIndexes = (elementText: string, chunkTexts: string[]): number[] => {
  const normalizedElementText = normalizeText(elementText);
  if (!normalizedElementText) {
    return [];
  }

  return chunkTexts.flatMap((chunkText, index) => {
    const normalizedChunkText = normalizeText(chunkText);
    const isMatch =
      normalizedChunkText === normalizedElementText ||
      normalizedChunkText.includes(normalizedElementText) ||
      normalizedElementText.includes(normalizedChunkText);
    return isMatch ? [index] : [];
  });
};

const buildReadableChunkMatches = (
  container: HTMLElement,
  chunkTexts: string[]
): ReadableChunkMatch[] =>
  buildReadableTextElements(container)
    .map(readableElement => ({
      ...readableElement,
      chunkIndexes: findMatchingChunkIndexes(readableElement.text, chunkTexts),
    }))
    .filter(match => match.chunkIndexes.length > 0);

const findEventMatch = (
  matches: ReadableChunkMatch[],
  eventTarget: EventTarget | null
): ReadableChunkMatch | null => {
  if (!(eventTarget instanceof Node)) {
    return null;
  }

  return matches.find(match => match.element.contains(eventTarget)) ?? null;
};

const resolveHoveredChunkIndex = (match: ReadableChunkMatch, clientY: number): number => {
  if (match.chunkIndexes.length === 1) {
    return match.chunkIndexes[0] ?? 0;
  }

  const rect = match.element.getBoundingClientRect();
  const relativeY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  const boundedProgress = Math.min(Math.max(relativeY, 0), 0.999_999);
  const candidateIndex = Math.floor(boundedProgress * match.chunkIndexes.length);
  return match.chunkIndexes[candidateIndex] ?? match.chunkIndexes[0] ?? 0;
};

const buildOverlayRects = (
  matches: ReadableChunkMatch[],
  chunkIndex: number
): TtsTextPickerOverlayRect[] =>
  matches.flatMap(match => {
    const candidateIndex = match.chunkIndexes.indexOf(chunkIndex);
    if (candidateIndex === -1) {
      return [];
    }

    const rect = match.element.getBoundingClientRect();
    const segmentHeight = rect.height / match.chunkIndexes.length;
    return [
      {
        height: segmentHeight,
        left: rect.left - OVERLAY_HORIZONTAL_INSET_PX,
        top: rect.top + segmentHeight * candidateIndex,
        width: rect.width + OVERLAY_HORIZONTAL_INSET_PX * 2,
      },
    ];
  });

const areOverlayRectsEqual = (
  currentRects: TtsTextPickerOverlayRect[],
  nextRects: TtsTextPickerOverlayRect[]
): boolean =>
  currentRects.length === nextRects.length &&
  currentRects.every((currentRect, index) => {
    const nextRect = nextRects[index];
    return (
      currentRect.height === nextRect?.height &&
      currentRect.left === nextRect.left &&
      currentRect.top === nextRect.top &&
      currentRect.width === nextRect.width
    );
  });

export const useTtsTextPicker = ({
  chunkTexts,
  contentRef,
  onSelectChunk,
}: UseTtsTextPickerParams) => {
  const [isActive, setIsActiveState] = useState(false);
  const [hoveredChunkIndex, setHoveredChunkIndex] = useState<number | null>(null);
  const [overlayRects, setOverlayRects] = useState<TtsTextPickerOverlayRect[]>([]);

  const clearHighlight = useCallback(() => {
    setHoveredChunkIndex(currentIndex => (currentIndex === null ? currentIndex : null));
    setOverlayRects(currentRects => (currentRects.length === 0 ? currentRects : []));
  }, []);

  const setIsActive = useCallback(
    (nextIsActive: boolean) => {
      setIsActiveState(currentIsActive =>
        currentIsActive === nextIsActive ? currentIsActive : nextIsActive
      );
      if (!nextIsActive) {
        clearHighlight();
      }
    },
    [clearHighlight]
  );

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const container = contentRef.current;
    if (!container) {
      return;
    }

    const matches = buildReadableChunkMatches(container, chunkTexts);
    if (matches.length === 0) {
      return;
    }

    const previousCursor = container.style.cursor;
    container.style.cursor = 'crosshair';

    const updateHighlight = (event: MouseEvent) => {
      const match = findEventMatch(matches, event.target);
      if (!match) {
        clearHighlight();
        return null;
      }

      const chunkIndex = resolveHoveredChunkIndex(match, event.clientY);
      const nextRects = buildOverlayRects(matches, chunkIndex);
      setHoveredChunkIndex(currentIndex =>
        currentIndex === chunkIndex ? currentIndex : chunkIndex
      );
      setOverlayRects(currentRects =>
        areOverlayRectsEqual(currentRects, nextRects) ? currentRects : nextRects
      );
      return chunkIndex;
    };

    const handlePointerMove = (event: PointerEvent) => {
      updateHighlight(event);
    };
    const handleClick = (event: MouseEvent) => {
      const chunkIndex = updateHighlight(event);
      if (chunkIndex === null) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      onSelectChunk(chunkIndex);
      setIsActive(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsActive(false);
      }
    };

    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('pointerleave', clearHighlight);
    container.addEventListener('click', handleClick, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', clearHighlight, true);

    return () => {
      container.style.cursor = previousCursor;
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('pointerleave', clearHighlight);
      container.removeEventListener('click', handleClick, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', clearHighlight, true);
    };
  }, [chunkTexts, clearHighlight, contentRef, isActive, onSelectChunk, setIsActive]);

  return {
    hoveredChunkIndex,
    isActive,
    overlayRects,
    setIsActive,
  };
};
