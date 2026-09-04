import type { UIMessage } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMobileKeyboardOffset } from '../../hooks/useMobileKeyboardOffset.ts';
import type { HomeChatMode, Message } from '../../types.ts';
import type {
  HomeChatSurfaceState,
  LibraryMessageSendHandler,
  StopGenerationHandler,
} from './HomeChatComposer.tsx';
import { getActiveLibraryMessages } from './HomeChatConversation.tsx';

const readIsMobileViewport = () =>
  globalThis.window !== undefined ? globalThis.window.innerWidth < 768 : false;

interface UseHomeChatPanelStateArgs {
  readonly assessmentComplete: boolean;
  readonly assessmentMessages: Message[];
  readonly compactWhenEmpty: boolean;
  readonly homeChatMode: HomeChatMode;
  readonly isLibraryModeLoading: boolean;
  readonly isNewCourseLoading: boolean;
  readonly libraryMessages: UIMessage[];
  readonly onCancelNewCourse?: StopGenerationHandler;
  readonly onClearLibraryMessages?: () => void;
  readonly onHomeChatModeChange: (mode: HomeChatMode) => void;
  readonly onLibraryMessageSend: LibraryMessageSendHandler;
}

export const useHomeChatPanelState = ({
  assessmentComplete,
  assessmentMessages,
  compactWhenEmpty,
  homeChatMode,
  isLibraryModeLoading,
  isNewCourseLoading,
  libraryMessages,
  onCancelNewCourse,
  onClearLibraryMessages,
  onHomeChatModeChange,
  onLibraryMessageSend,
}: UseHomeChatPanelStateArgs) => {
  const [activeSurface, setActiveSurface] = useState<HomeChatSurfaceState>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(readIsMobileViewport);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousHomeChatModeRef = useRef(homeChatMode);
  const { viewportHeight } = useMobileKeyboardOffset();
  const visibleLibraryMessages = useMemo(
    () => getActiveLibraryMessages(libraryMessages),
    [libraryMessages]
  );
  const activeMessages =
    homeChatMode === 'new-course' ? assessmentMessages : visibleLibraryMessages;
  const isLoading = homeChatMode === 'new-course' ? isNewCourseLoading : isLibraryModeLoading;
  const hasActiveChat = activeMessages.length > 0 || isLoading || assessmentComplete;
  const showClearChat =
    (homeChatMode === 'library-query' &&
      visibleLibraryMessages.length > 0 &&
      Boolean(onClearLibraryMessages)) ||
    (homeChatMode === 'new-course' && assessmentMessages.length > 0 && Boolean(onCancelNewCourse));

  useEffect(() => {
    if (previousHomeChatModeRef.current === homeChatMode) return;
    previousHomeChatModeRef.current = homeChatMode;
    setActiveSurface(null);
  }, [homeChatMode]);

  useEffect(() => {
    if (globalThis.window === undefined) return;
    const updateViewport = () => setIsMobileViewport(readIsMobileViewport());
    updateViewport();
    globalThis.window.addEventListener('resize', updateViewport);
    return () => globalThis.window.removeEventListener('resize', updateViewport);
  }, []);

  return {
    activeSurface,
    hasActiveChat,
    inputRef,
    isCompactSurface: compactWhenEmpty && !hasActiveChat,
    isLibraryAwaitingFirstResponse:
      homeChatMode === 'library-query' &&
      isLoading &&
      !visibleLibraryMessages.some(message => message.role === 'assistant'),
    isLoading,
    isMobileViewport,
    onModeChange: (mode: HomeChatMode) => {
      setActiveSurface(null);
      onHomeChatModeChange(mode);
    },
    onStopGeneration: homeChatMode === 'new-course' ? onCancelNewCourse : onLibraryMessageSend.stop,
    setActiveSurface,
    showClearChat,
    viewportHeight,
    visibleLibraryMessages,
  };
};
