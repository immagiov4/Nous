import { memo, startTransition, useDeferredValue, useEffect, useRef, useState } from 'react';

import MarkdownRenderer, { type MarkdownRendererProps } from './MarkdownRenderer.tsx';

interface StreamingMarkdownRendererProps extends MarkdownRendererProps {
  isStreaming?: boolean;
}

const STREAMING_MARKDOWN_MIN_UPDATE_MS = 96;
const STREAMING_MARKDOWN_MAX_STALENESS_MS = 320;
const STREAMING_MARKDOWN_MIN_BATCH_CHARS = 32;

const hasStreamingBoundary = (nextContent: string, committedContent: string): boolean => {
  const appendedContent = nextContent.slice(committedContent.length);

  if (!appendedContent) {
    return false;
  }

  return (
    appendedContent.length >= STREAMING_MARKDOWN_MIN_BATCH_CHARS ||
    /\n{2,}/.test(appendedContent) ||
    /(?:```|~~~)/.test(appendedContent) ||
    /\n(?:[-*+]|\d+\.)\s/.test(appendedContent) ||
    /[.!?;:]\s*$/.test(nextContent) ||
    /\n$/.test(nextContent)
  );
};

const StreamingMarkdownRenderer = ({
  content,
  isStreaming = false,
  ...markdownProps
}: StreamingMarkdownRendererProps) => {
  const [committedContent, setCommittedContent] = useState(content);
  const latestContentRef = useRef(content);
  const lastCommitAtRef = useRef(Date.now());
  const flushTimeoutRef = useRef<number | null>(null);

  const clearPendingFlush = () => {
    if (flushTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(flushTimeoutRef.current);
    flushTimeoutRef.current = null;
  };

  const commitContent = (nextContent: string) => {
    clearPendingFlush();
    latestContentRef.current = nextContent;
    lastCommitAtRef.current = Date.now();
    startTransition(() => {
      setCommittedContent(currentContent =>
        currentContent === nextContent ? currentContent : nextContent
      );
    });
  };

  useEffect(() => {
    latestContentRef.current = content;

    if (!isStreaming || content.length <= committedContent.length) {
      if (content !== committedContent) {
        commitContent(content);
      } else {
        clearPendingFlush();
      }
      return;
    }

    if (!committedContent) {
      commitContent(content);
      return;
    }

    const now = Date.now();
    const elapsedSinceLastCommit = now - lastCommitAtRef.current;
    const reachedStreamingBoundary = hasStreamingBoundary(content, committedContent);

    if (
      elapsedSinceLastCommit >= STREAMING_MARKDOWN_MAX_STALENESS_MS ||
      (elapsedSinceLastCommit >= STREAMING_MARKDOWN_MIN_UPDATE_MS && reachedStreamingBoundary)
    ) {
      commitContent(content);
      return;
    }

    clearPendingFlush();
    const nextFlushDelay = reachedStreamingBoundary
      ? Math.max(STREAMING_MARKDOWN_MIN_UPDATE_MS - elapsedSinceLastCommit, 0)
      : Math.max(STREAMING_MARKDOWN_MAX_STALENESS_MS - elapsedSinceLastCommit, 0);

    flushTimeoutRef.current = window.setTimeout(() => {
      commitContent(latestContentRef.current);
    }, nextFlushDelay);

    return clearPendingFlush;
  }, [committedContent, content, isStreaming]);

  useEffect(
    () => () => {
      clearPendingFlush();
    },
    []
  );

  const deferredCommittedContent = useDeferredValue(committedContent);
  const visibleContent = isStreaming ? deferredCommittedContent : committedContent;

  return <MarkdownRenderer {...markdownProps} content={visibleContent} />;
};

export default memo(StreamingMarkdownRenderer);
