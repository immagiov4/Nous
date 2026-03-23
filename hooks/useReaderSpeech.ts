import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import { buildReadableBlocks } from '../utils/readingText';

interface UseReaderSpeechBlocksArgs {
  contentRef: RefObject<HTMLDivElement | null>;
  sectionContent: string;
}

interface UseReaderCalibrationArgs {
  contentRef: RefObject<HTMLDivElement | null>;
  isAutoTrackEnabled: boolean;
  setCalibrationFromRelativeY: (progress: number) => void;
}

export const useReaderSpeechBlocks = ({
  contentRef,
  sectionContent,
}: UseReaderSpeechBlocksArgs) => {
  const [speechBlocks, setSpeechBlocks] = useState<string[]>([]);

  const updateSpeechBlocks = useCallback(() => {
    if (!contentRef.current) {
      return;
    }

    const nextSpeechBlocks = buildReadableBlocks(contentRef.current).map(({ text }) => text);
    setSpeechBlocks(previousBlocks => {
      if (
        previousBlocks.length === nextSpeechBlocks.length &&
        previousBlocks.every((block, index) => block === nextSpeechBlocks[index])
      ) {
        return previousBlocks;
      }

      return nextSpeechBlocks;
    });
  }, [contentRef]);

  useEffect(() => {
    if (!sectionContent) {
      setSpeechBlocks([]);
      return;
    }

    const contentElement = contentRef.current;
    if (!contentElement) {
      return;
    }

    let frameId: number | null = null;

    const scheduleSpeechBlocksUpdate = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateSpeechBlocks();
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      scheduleSpeechBlocksUpdate();
    });
    const mutationObserver = new MutationObserver(() => {
      scheduleSpeechBlocksUpdate();
    });

    resizeObserver.observe(contentElement);
    mutationObserver.observe(contentElement, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    scheduleSpeechBlocksUpdate();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [contentRef, sectionContent]);

  return useMemo(
    () => ({
      speechBlocks,
    }),
    [speechBlocks]
  );
};

export const useReaderCalibration = ({
  contentRef,
  isAutoTrackEnabled,
  setCalibrationFromRelativeY,
}: UseReaderCalibrationArgs) => {
  const handleDocumentDoubleClick = useCallback((event: globalThis.MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || !contentRef.current?.contains(target)) {
      return;
    }

    const blocks = buildReadableBlocks(contentRef.current);
    if (blocks.length === 0) {
      return;
    }

    const rect = contentRef.current.getBoundingClientRect();
    const clickY = event.clientY - rect.top;
    const block =
      blocks.find(({ hitTop, hitBottom }) => clickY >= hitTop && clickY <= hitBottom) ||
      blocks.reduce((closest, current) => {
        const closestDistance = Math.min(
          Math.abs(clickY - closest.hitTop),
          Math.abs(clickY - closest.hitBottom)
        );
        const currentDistance = Math.min(
          Math.abs(clickY - current.hitTop),
          Math.abs(clickY - current.hitBottom)
        );
        return currentDistance < closestDistance ? current : closest;
      });

    const segmentHeight = Math.max(1, block.bottom - block.top);
    const localProgress = Math.max(0, Math.min(1, (clickY - block.top) / segmentHeight));
    const targetProgress = block.startAudio + (block.endAudio - block.startAudio) * localProgress;

    setCalibrationFromRelativeY(targetProgress);
  }, [contentRef, setCalibrationFromRelativeY]);

  useEffect(() => {
    if (!isAutoTrackEnabled) {
      return;
    }

    document.addEventListener('dblclick', handleDocumentDoubleClick);
    return () => {
      document.removeEventListener('dblclick', handleDocumentDoubleClick);
    };
  }, [handleDocumentDoubleClick, isAutoTrackEnabled]);
};
