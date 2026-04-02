import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import { buildReadableBlocks } from '../utils/readingText';

interface UseReaderSpeechBlocksArgs {
  contentRef: RefObject<HTMLDivElement | null>;
  sectionContent: string;
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
  }, [contentRef, sectionContent, updateSpeechBlocks]);

  return useMemo(
    () => ({
      speechBlocks,
    }),
    [speechBlocks]
  );
};
