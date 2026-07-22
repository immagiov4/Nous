import { isToolUIPart, type UIMessage } from 'ai';
import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowUp,
  BookOpen,
  BookPlus,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  GitFork,
  Globe,
  List,
  Loader2,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import logoUrl from '@/assets/logo.svg';
import logoDarkModeUrl from '@/assets/logo_darkmode.svg';
import { usePersistedLibraryFolderExpansion } from '../../hooks/library/usePersistedLibraryFolderExpansion.ts';
import { useMobileKeyboardOffset } from '../../hooks/useMobileKeyboardOffset.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type {
  HomeChatMode,
  LearningArtifactRenderPayload,
  LibraryContextRef,
  LibraryTree,
  LibraryTreeNode,
  Message,
} from '../../types.ts';
import {
  dedupeUiMessagesById,
  getUiMessageRenderableParts,
  getUiMessageText,
} from '../../utils/uiChat.ts';
import type {
  ChatArtifactActionRequest,
  ChatArtifactRegenerateRequest,
  ChatArtifactReplaceRequest,
} from '../shared/ChatArtifactRenderer.tsx';
import ChatArtifactRenderer from '../shared/ChatArtifactRenderer.tsx';
import MarkdownRenderer from '../shared/MarkdownRenderer.tsx';
import {
  appendSpeechTranscription,
  default as SpeechInputButton,
} from '../shared/SpeechInputButton.tsx';
import StreamingMarkdownRenderer from '../shared/StreamingMarkdownRenderer.tsx';

interface HomeChatPanelProps {
  readonly assessmentComplete: boolean;
  readonly assessmentMessages: Message[];
  readonly homeChatMode: HomeChatMode;
  readonly isDarkMode: boolean;
  readonly isLibraryLoading: boolean;
  readonly isLibraryModeLoading: boolean;
  readonly isNewCourseLoading: boolean;
  readonly libraryAttachedContextRefs: LibraryContextRef[];
  readonly libraryArtifactPayloadsByToolCallId?: Record<string, LearningArtifactRenderPayload[]>;
  readonly libraryArtifactPreviewIdOverride?: string | null;
  readonly libraryArtifactPortalContainer?: HTMLElement | null;
  readonly libraryFloatingArtifactPayloads?: LearningArtifactRenderPayload[];
  readonly libraryErrorMessage: string | null;
  readonly libraryMessages: UIMessage[];
  readonly libraryTree: LibraryTree;
  readonly libraryWebSearch: boolean;
  readonly libraryGenerateArtifacts: boolean;
  readonly newCourseLoadingStatus: string;
  readonly pendingFileName: string | null;
  readonly pendingFileNames?: string[];
  readonly draftValueOverride?: string;
  readonly draftTemplate?: {
    id: string;
    mode?: HomeChatMode;
    selection?: { end: number; start: number };
    value: string;
  };
  readonly scrollProgressOverride?: number;
  readonly compactWhenEmpty?: boolean;
  readonly hideHeaderCopy?: boolean;
  readonly hideModeSelector?: boolean;
  readonly inputPlaceholder?: string;
  readonly showChatAvatars?: boolean;
  readonly onClearPendingFile: () => void;
  readonly onClearLibraryMessages?: () => void;
  readonly onCancelNewCourse?: () => void;
  readonly onContinueAssessment?: () => void;
  readonly onConfirmGenerate: () => void;
  readonly onHomeChatModeChange: (mode: HomeChatMode) => void;
  readonly onLibraryMessageSend: (message: string) => void | Promise<void>;
  readonly onLibraryArtifactNoteApprove?: (
    toolCallId: string,
    input: {
      artifactIds: string[];
      lessonId: string;
      noteDraft: string;
      projectId: string;
      rationale: string;
    }
  ) => Promise<void>;
  readonly onLibraryArtifactNoteReject?: (toolCallId: string) => void;
  readonly onLibraryArtifactDiscard?: (request: ChatArtifactActionRequest) => void;
  readonly onLibraryArtifactRegenerate?: (
    request: ChatArtifactRegenerateRequest
  ) => Promise<boolean> | boolean;
  readonly onLibraryArtifactReplace?: (request: ChatArtifactReplaceRequest) => Promise<void> | void;
  readonly onLibraryWebSearchChange: (value: boolean) => void;
  readonly onLibraryGenerateArtifactsChange: (value: boolean) => void;
  readonly onSendAssessmentMessage: (message: string) => Promise<void>;
  readonly onToggleLibraryContextRef: (reference: LibraryContextRef) => void;
  readonly onUploadSourceClick: () => void;
}

type SurfaceState = null | 'attachment-menu' | 'tool-menu';
type MenuAlign = 'start' | 'end';
type MenuVerticalPlacement = 'above' | 'below';
type LibraryToolPart = Extract<UIMessage['parts'][number], { type: `tool-${string}` }>;

const FLOATING_MENU_GAP_PX = 12;
const FLOATING_MENU_VIEWPORT_MARGIN_PX = 16;
const MOBILE_ACTIVE_CHAT_VIEWPORT_RATIO = 0.75;

interface RequestSaveLearningArtifactNoteInput {
  artifactIds: string[];
  lessonId: string;
  noteDraft: string;
  projectId: string;
  rationale: string;
}

const isRequestSaveLearningArtifactNoteInput = (
  value: unknown
): value is RequestSaveLearningArtifactNoteInput => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<RequestSaveLearningArtifactNoteInput>;

  return (
    Array.isArray(candidate.artifactIds) &&
    candidate.artifactIds.every(item => typeof item === 'string') &&
    typeof candidate.lessonId === 'string' &&
    typeof candidate.noteDraft === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.rationale === 'string'
  );
};

const readIsMobileViewport = () =>
  typeof globalThis.window !== 'undefined' ? globalThis.window.innerWidth < 768 : false;

const getMenuVerticalPlacement = (
  anchorRect: DOMRect,
  menuHeight: number,
  viewportHeight: number
): MenuVerticalPlacement => {
  const spaceAbove = anchorRect.top - FLOATING_MENU_GAP_PX - FLOATING_MENU_VIEWPORT_MARGIN_PX;
  const spaceBelow =
    viewportHeight - anchorRect.bottom - FLOATING_MENU_GAP_PX - FLOATING_MENU_VIEWPORT_MARGIN_PX;

  if (spaceAbove >= menuHeight) {
    return 'above';
  }
  if (spaceBelow >= menuHeight) {
    return 'below';
  }

  return spaceBelow > spaceAbove ? 'below' : 'above';
};

const isVisibleLibraryToolState = (state: LibraryToolPart['state']) =>
  state === 'input-streaming' ||
  state === 'input-available' ||
  state === 'approval-requested' ||
  state === 'approval-responded' ||
  state === 'output-available' ||
  state === 'output-error' ||
  state === 'output-denied';

const isPendingLibraryToolState = (state: LibraryToolPart['state']) =>
  state === 'input-streaming' || state === 'input-available' || state === 'approval-requested';

const buildAssessmentMessageKeys = (messages: Message[]) => {
  const counts = new Map<string, number>();

  return messages.map(message => {
    const baseKey = `${message.role}:${message.text}`;
    const nextCount = (counts.get(baseKey) || 0) + 1;
    counts.set(baseKey, nextCount);
    return `${baseKey}:${nextCount}`;
  });
};

const hasVisibleLibraryMessageContent = (message: UIMessage) =>
  getUiMessageRenderableParts(message).some(part => {
    if (part.kind === 'text') {
      return true;
    }

    if (!isToolUIPart(part.part)) {
      return false;
    }

    return isVisibleLibraryToolState(part.part.state);
  });

const getActiveLibraryMessages = (messages: UIMessage[]) =>
  dedupeUiMessagesById(messages).filter(message =>
    message.role === 'user' ? true : hasVisibleLibraryMessageContent(message)
  );

interface LibraryAssistantTurn {
  key: string;
  messages: UIMessage[];
  parts: UIMessage['parts'];
}

interface MergedAssistantText {
  isStreaming: boolean;
  text: string;
}

const isLibraryAssistantTurn = (
  turn: UIMessage | LibraryAssistantTurn
): turn is LibraryAssistantTurn => !('role' in turn);

const groupLibraryAssistantTurns = (messages: UIMessage[]) => {
  const turns: Array<UIMessage | LibraryAssistantTurn> = [];
  let currentAssistantMessages: UIMessage[] = [];

  const flushAssistantTurn = () => {
    if (currentAssistantMessages.length === 0) {
      return;
    }

    turns.push({
      key: currentAssistantMessages.map(message => message.id || 'assistant').join('__'),
      messages: currentAssistantMessages,
      parts: currentAssistantMessages.flatMap(message => message.parts),
    });
    currentAssistantMessages = [];
  };

  messages.forEach(message => {
    if (message.role === 'assistant') {
      currentAssistantMessages.push(message);
      return;
    }

    flushAssistantTurn();
    turns.push(message);
  });

  flushAssistantTurn();
  return turns;
};

const getMergedLibraryAssistantText = (messages: UIMessage[]): MergedAssistantText | null => {
  const textParts = messages.flatMap(message =>
    getUiMessageRenderableParts(message).filter(part => part.kind === 'text')
  );

  if (textParts.length === 0) {
    return null;
  }

  const text = textParts
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n\n');

  if (!text) {
    return null;
  }

  return {
    isStreaming: textParts.some(part => part.isStreaming),
    text,
  };
};

const LIBRARY_TOOL_META: Record<string, { icon: LucideIcon; getLabel: () => string }> = {
  getLessonDetails: { icon: FileText, getLabel: () => t('Dettagli lezioni') },
  getLearningArtifacts: { icon: FileText, getLabel: () => t('Artefatti lezioni') },
  generateLearningArtifact: { icon: Sparkles, getLabel: () => t('Genera artefatto') },
  getProjectOverviews: { icon: BookOpen, getLabel: () => t('Panoramica corsi') },
  getProjectStructures: { icon: GitFork, getLabel: () => t('Struttura corsi') },
  listLibraryTree: { icon: List, getLabel: () => t('Indice libreria') },
  requestSaveLearningArtifactNote: { icon: FileText, getLabel: () => t('Salva nota') },
  searchLibrary: { icon: Search, getLabel: () => t('Ricerca contenuti') },
  searchWeb: { icon: Globe, getLabel: () => t('Ricerca web') },
  startCourseAssessment: { icon: BookOpen, getLabel: () => t('Avvio nuovo corso') },
};

const getToolMeta = (part: UIMessage['parts'][number]) => {
  if (!isToolUIPart(part)) return { icon: Search, label: t('Tool') };
  const raw =
    'toolName' in part && typeof part.toolName === 'string'
      ? part.toolName
      : part.type.startsWith('tool-')
        ? part.type.slice(5)
        : '';
  const configuredMeta = LIBRARY_TOOL_META[raw];
  return configuredMeta
    ? { icon: configuredMeta.icon, label: configuredMeta.getLabel() }
    : {
        icon: Search,
        label: raw.replaceAll(/([A-Z])/g, ' $1').trim() || t('Tool'),
      };
};

const getToolArgHint = (part: LibraryToolPart): string | null => {
  if (part.state === 'input-streaming') return null;
  const input = (part as { input?: Record<string, unknown> }).input;
  if (!input) return null;
  const toolName = 'toolName' in part && typeof part.toolName === 'string' ? part.toolName : '';
  switch (toolName) {
    case 'getProjectStructures':
    case 'getProjectOverviews': {
      const ids = input.projectIds as string[] | undefined;
      if (!ids || ids.length === 0) return null;
      return ids.length === 1 ? t('1 corso') : t('{count} corsi', { count: ids.length });
    }
    case 'getLessonDetails': {
      const reqs = input.requests as Array<{ lessonIds?: string[] }> | undefined;
      if (!reqs) return null;
      const count = reqs.reduce((sum, r) => sum + (r.lessonIds?.length ?? 0), 0);
      return count === 0 ? null : count === 1 ? t('1 lezione') : t('{count} lezioni', { count });
    }
    case 'searchLibrary':
    case 'searchWeb': {
      const query = input.query as string | undefined;
      if (!query) return null;
      return query.length > 30 ? `${query.slice(0, 30)}\u2026` : query;
    }
    case 'startCourseAssessment': {
      const topic = input.topic as string | undefined;
      if (!topic) return null;
      return topic.length > 30 ? `${topic.slice(0, 30)}\u2026` : topic;
    }
    default:
      return null;
  }
};

const ToolChipFadeIn = ({ children }: { children: ReactNode }) => {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <span
      className="inline-flex min-w-0 flex-1 items-center gap-x-1.5"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 0.35s ease' }}
    >
      {children}
    </span>
  );
};

export default function HomeChatPanel({
  assessmentComplete,
  assessmentMessages,
  homeChatMode,
  isDarkMode,
  isLibraryLoading,
  isLibraryModeLoading,
  isNewCourseLoading,
  libraryAttachedContextRefs,
  libraryArtifactPayloadsByToolCallId = {},
  libraryArtifactPreviewIdOverride,
  libraryArtifactPortalContainer,
  libraryFloatingArtifactPayloads = [],
  libraryErrorMessage,
  libraryMessages,
  libraryTree,
  libraryWebSearch,
  libraryGenerateArtifacts,
  newCourseLoadingStatus,
  pendingFileName,
  pendingFileNames,
  draftValueOverride,
  draftTemplate,
  scrollProgressOverride,
  compactWhenEmpty = false,
  hideHeaderCopy = false,
  hideModeSelector = false,
  inputPlaceholder,
  showChatAvatars = false,
  onClearPendingFile,
  onClearLibraryMessages,
  onCancelNewCourse,
  onContinueAssessment,
  onConfirmGenerate,
  onHomeChatModeChange,
  onLibraryMessageSend,
  onLibraryArtifactNoteApprove = async () => {},
  onLibraryArtifactNoteReject = () => {},
  onLibraryArtifactRegenerate = () => false,
  onLibraryArtifactReplace = () => {},
  onLibraryWebSearchChange,
  onLibraryGenerateArtifactsChange,
  onSendAssessmentMessage,
  onToggleLibraryContextRef,
  onUploadSourceClick,
}: HomeChatPanelProps) {
  const displayedPendingFileNames = pendingFileNames?.length
    ? pendingFileNames
    : pendingFileName
      ? [pendingFileName]
      : [];
  const pendingFileNameOccurrences = new Map<string, number>();
  const displayedPendingFiles = displayedPendingFileNames.map(name => {
    const occurrence = (pendingFileNameOccurrences.get(name) || 0) + 1;
    pendingFileNameOccurrences.set(name, occurrence);
    return { key: `${name}-${occurrence}`, name };
  });
  const [draftByMode, setDraftByMode] = useState<Record<HomeChatMode, string>>({
    'library-query': homeChatMode === 'library-query' ? draftTemplate?.value || '' : '',
    'new-course': homeChatMode === 'new-course' ? draftTemplate?.value || '' : '',
  });
  const { expandedFolderIds, toggleFolderExpansion } =
    usePersistedLibraryFolderExpansion(libraryTree);
  const [activeSurface, setActiveSurface] = useState<SurfaceState>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(readIsMobileViewport);
  const [toolMenuAlign, setToolMenuAlign] = useState<MenuAlign>('start');
  const [attachmentMenuAlign, setAttachmentMenuAlign] = useState<MenuAlign>('start');
  const [toolMenuVerticalPlacement, setToolMenuVerticalPlacement] =
    useState<MenuVerticalPlacement>('above');
  const [attachmentMenuVerticalPlacement, setAttachmentMenuVerticalPlacement] =
    useState<MenuVerticalPlacement>('above');
  const [scrollOffsetOverride, setScrollOffsetOverride] = useState(0);

  const toolMenuButtonRef = useRef<HTMLButtonElement>(null);
  const attachmentButtonRef = useRef<HTMLButtonElement>(null);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const surfaceRootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);

  const { viewportHeight } = useMobileKeyboardOffset();

  const assessmentMessageKeys = useMemo(
    () => buildAssessmentMessageKeys(assessmentMessages),
    [assessmentMessages]
  );
  const visibleLibraryMessages = useMemo(
    () => getActiveLibraryMessages(libraryMessages),
    [libraryMessages]
  );
  const visibleLibraryTurns = useMemo(
    () => groupLibraryAssistantTurns(visibleLibraryMessages),
    [visibleLibraryMessages]
  );
  const attachedContextProjectIds = useMemo(() => {
    const projectIds = new Set<string>();

    libraryAttachedContextRefs.forEach(reference => {
      if (reference.kind === 'project') {
        projectIds.add(reference.id);
        return;
      }

      libraryTree.descendantProjectIdsByFolderId[reference.id]?.forEach(projectId => {
        projectIds.add(projectId);
      });
    });

    return projectIds;
  }, [libraryAttachedContextRefs, libraryTree.descendantProjectIdsByFolderId]);
  const activeLibraryToolCount = Number(libraryWebSearch) + Number(libraryGenerateArtifacts);

  const currentDraft = draftValueOverride ?? draftByMode[homeChatMode];
  const activeMessages =
    homeChatMode === 'new-course' ? assessmentMessages : visibleLibraryMessages;
  const hasMessages = activeMessages.length > 0;
  const isLoading = homeChatMode === 'new-course' ? isNewCourseLoading : isLibraryModeLoading;
  const hasActiveChat = hasMessages || isLoading || assessmentComplete;

  const isLibraryAwaitingFirstResponse =
    homeChatMode === 'library-query' &&
    isLoading &&
    !visibleLibraryMessages.some(message => message.role === 'assistant');
  const activeMessagesContentLength =
    homeChatMode === 'new-course'
      ? assessmentMessages.reduce((totalLength, message) => totalLength + message.text.length, 0)
      : visibleLibraryMessages.reduce(
          (totalLength, message) => totalLength + getUiMessageText(message).length,
          0
        );
  const scrollMeasurementKey = `${activeMessages.length}:${activeMessagesContentLength}:${assessmentComplete}:${isLoading}`;
  const showHeader = !hideHeaderCopy || !hideModeSelector;
  const showClearChat =
    (homeChatMode === 'library-query' &&
      visibleLibraryMessages.length > 0 &&
      Boolean(onClearLibraryMessages)) ||
    (homeChatMode === 'new-course' && assessmentMessages.length > 0 && Boolean(onCancelNewCourse));
  const reserveClearButtonSpace = showClearChat && !showHeader;
  const mobileChatStyle =
    isMobileViewport && viewportHeight != null
      ? hasActiveChat
        ? { height: `${Math.floor(viewportHeight * MOBILE_ACTIVE_CHAT_VIEWPORT_RATIO)}px` }
        : { maxHeight: `${viewportHeight}px` }
      : undefined;
  const assistantAvatar = showChatAvatars ? (
    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900">
      <img
        src={isDarkMode ? logoDarkModeUrl : logoUrl}
        alt="Assistente Nous"
        className="h-5 w-5 object-contain"
      />
    </span>
  ) : null;
  const userAvatar = showChatAvatars ? (
    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-200 text-xs font-semibold text-stone-700 dark:bg-stone-700 dark:text-stone-100">
      G
    </span>
  ) : null;

  useLayoutEffect(() => {
    if (
      !scrollMeasurementKey ||
      scrollProgressOverride === undefined ||
      !messagesScrollRef.current
    ) {
      return;
    }

    const maxScrollTop = Math.max(
      0,
      messagesScrollRef.current.scrollHeight - messagesScrollRef.current.clientHeight
    );
    const progress = Math.min(1, Math.max(0, scrollProgressOverride));
    const nextOffset = Math.round(maxScrollTop * progress);
    setScrollOffsetOverride(currentOffset =>
      currentOffset === nextOffset ? currentOffset : nextOffset
    );
  }, [scrollMeasurementKey, scrollProgressOverride]);

  useEffect(() => {
    if (typeof globalThis.window === 'undefined') {
      return;
    }

    const updateViewport = () => {
      setIsMobileViewport(readIsMobileViewport());
    };

    updateViewport();
    globalThis.window.addEventListener('resize', updateViewport);
    return () => {
      globalThis.window.removeEventListener('resize', updateViewport);
    };
  }, []);

  useLayoutEffect(() => {
    if (scrollProgressOverride !== undefined) {
      return;
    }
    const lastItem = activeMessages.at(-1) || null;
    if (!lastItem && !assessmentComplete && !isLoading) {
      return;
    }

    const messagesScroll = messagesScrollRef.current;
    if (messagesScroll) {
      messagesScroll.scrollTop = messagesScroll.scrollHeight;
    }
  }, [activeMessages, assessmentComplete, isLoading, scrollProgressOverride]);

  useLayoutEffect(() => {
    if (
      !isMobileViewport ||
      viewportHeight == null ||
      document.activeElement !== inputRef.current
    ) {
      return;
    }

    inputRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isMobileViewport, viewportHeight]);

  useEffect(() => {
    if (!draftTemplate) {
      return;
    }
    const targetMode = draftTemplate.mode ?? homeChatMode;
    if (targetMode !== homeChatMode) {
      return;
    }
    globalThis.window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (draftTemplate.selection) {
        inputRef.current?.setSelectionRange(
          draftTemplate.selection.start,
          draftTemplate.selection.end
        );
      }
    });
  }, [draftTemplate, homeChatMode]);

  useEffect(() => {
    if (isMobileViewport || draftValueOverride !== undefined) {
      return;
    }
    inputRef.current?.focus();
  }, [draftValueOverride, isMobileViewport]);

  useLayoutEffect(() => {
    if (!activeSurface) {
      return;
    }

    const menuContentMeasurementKey =
      activeSurface === 'attachment-menu'
        ? `${isLibraryLoading}:${libraryTree.rootNodes.length}`
        : activeSurface;
    if (!menuContentMeasurementKey) {
      return;
    }

    const anchor =
      activeSurface === 'tool-menu' ? toolMenuButtonRef.current : attachmentButtonRef.current;
    const menu = activeSurface === 'tool-menu' ? toolMenuRef.current : attachmentMenuRef.current;
    if (!anchor || !menu) {
      return;
    }

    const updateMenuPlacement = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const align: MenuAlign =
        anchorRect.left > globalThis.window.innerWidth * 0.62 ? 'end' : 'start';
      const verticalPlacement = getMenuVerticalPlacement(
        anchorRect,
        menuRect.height,
        globalThis.window.innerHeight
      );

      if (activeSurface === 'tool-menu') {
        setToolMenuAlign(currentAlign => (currentAlign === align ? currentAlign : align));
        setToolMenuVerticalPlacement(currentPlacement =>
          currentPlacement === verticalPlacement ? currentPlacement : verticalPlacement
        );
        return;
      }

      setAttachmentMenuAlign(currentAlign => (currentAlign === align ? currentAlign : align));
      setAttachmentMenuVerticalPlacement(currentPlacement =>
        currentPlacement === verticalPlacement ? currentPlacement : verticalPlacement
      );
    };

    updateMenuPlacement();
    globalThis.window.addEventListener('resize', updateMenuPlacement);
    return () => {
      globalThis.window.removeEventListener('resize', updateMenuPlacement);
    };
  }, [activeSurface, isLibraryLoading, libraryTree.rootNodes.length]);

  useEffect(() => {
    if (!activeSurface) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || surfaceRootRef.current?.contains(target)) {
        return;
      }

      setActiveSurface(null);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [activeSurface]);

  const handleDraftChange = (value: string) => {
    setDraftByMode(currentDrafts => ({
      ...currentDrafts,
      [homeChatMode]: value,
    }));
  };

  const handleSpeechTranscription = (transcription: string) => {
    setDraftByMode(currentDrafts => ({
      ...currentDrafts,
      [homeChatMode]: appendSpeechTranscription(currentDrafts[homeChatMode], transcription),
    }));
    globalThis.window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const handleModeChange = (mode: HomeChatMode) => {
    closeMenus();
    onHomeChatModeChange(mode);
  };

  const closeMenus = () => {
    setActiveSurface(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedInput = currentDraft.trim();
    if (!trimmedInput) {
      return;
    }

    handleDraftChange('');
    closeMenus();

    if (homeChatMode === 'new-course') {
      await onSendAssessmentMessage(trimmedInput);
      return;
    }

    await onLibraryMessageSend(trimmedInput);
  };

  const renderAttachmentTreeNode = (node: LibraryTreeNode, depth = 0) => {
    const paddingLeft = 12 + depth * 18;

    if (node.kind === 'project') {
      const isSelected = attachedContextProjectIds.has(node.id);

      return (
        <label
          key={`project-${node.id}`}
          className="flex cursor-pointer items-start gap-3 rounded-2xl px-3 py-2 transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/70"
          style={{ paddingLeft }}
        >
          <span className="relative mt-0.5 h-5 w-5 shrink-0 rounded-md has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-orange-400">
            <input
              type="checkbox"
              checked={isSelected}
              aria-label={node.project.title}
              onChange={() =>
                onToggleLibraryContextRef({
                  id: node.id,
                  kind: 'project',
                  label: node.project.title,
                })
              }
              className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 focus-visible:outline-none"
            />
            <span
              aria-hidden="true"
              className={`flex h-full w-full items-center justify-center rounded-md border transition-colors ${
                isSelected
                  ? 'border-[#b45c28] bg-[#b45c28] text-white dark:border-[#e4a477] dark:bg-[#e4a477] dark:text-stone-950'
                  : 'border-stone-300 bg-white text-transparent dark:border-zinc-500 dark:bg-stone-800'
              }`}
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
            </span>
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-gray-900 dark:text-zinc-100">
              {node.project.title}
            </span>
            <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
              {t('{completed}/{total} lezioni completate', {
                completed: node.project.completedCount,
                total: node.project.lessonCount,
              })}
            </span>
          </span>
        </label>
      );
    }

    const isExpanded = expandedFolderIds.has(node.id);
    const isSelected =
      libraryAttachedContextRefs.some(
        reference => reference.id === node.id && reference.kind === 'folder'
      ) ||
      (node.descendantProjectIds.length > 0 &&
        node.descendantProjectIds.every(projectId => attachedContextProjectIds.has(projectId)));

    return (
      <div key={`folder-${node.id}`}>
        <div
          className="flex items-start rounded-2xl transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/70"
          style={{ paddingLeft }}
        >
          <span className="relative my-2 mr-2 h-5 w-5 shrink-0 rounded-md has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-orange-400">
            <input
              type="checkbox"
              checked={isSelected}
              aria-label={node.folder.name}
              onChange={() =>
                onToggleLibraryContextRef({
                  id: node.id,
                  kind: 'folder',
                  label: node.folder.name,
                })
              }
              className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 focus-visible:outline-none"
            />
            <span
              aria-hidden="true"
              className={`flex h-full w-full items-center justify-center rounded-md border transition-colors ${
                isSelected
                  ? 'border-[#b45c28] bg-[#b45c28] text-white dark:border-[#e4a477] dark:bg-[#e4a477] dark:text-stone-950'
                  : 'border-stone-300 bg-white text-transparent dark:border-zinc-500 dark:bg-stone-800'
              }`}
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
            </span>
          </span>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-start gap-3 py-2 pr-2 text-left"
            onClick={() => toggleFolderExpansion(node.id)}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-zinc-100">
                {isExpanded ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                )}
                <span className="truncate">{node.folder.name}</span>
              </span>
              <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                {t('{count} corsi inclusi', { count: node.descendantProjectIds.length })}
              </span>
            </span>
            {isExpanded ? (
              <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
            ) : (
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
            )}
          </button>
        </div>

        {isExpanded
          ? node.children.map(childNode => renderAttachmentTreeNode(childNode, depth + 1))
          : null}
      </div>
    );
  };

  const renderLibraryToolStrip = (parts: UIMessage['parts'], messageId: string) => {
    const toolParts = parts.filter(isToolUIPart).filter(p => isVisibleLibraryToolState(p.state));
    if (!toolParts.length) return null;

    const maxTools = isMobileViewport ? 2 : 4;
    const hasInProgress = toolParts.some(toolPart => isPendingLibraryToolState(toolPart.state));
    const truncated = toolParts.length > maxTools;
    const visibleTools = toolParts.slice(-maxTools);

    return (
      <div className="flex min-w-0 flex-nowrap items-center gap-x-2 overflow-hidden py-1.5 text-xs text-gray-600 dark:text-zinc-300">
        {truncated && <span className="shrink-0 text-gray-400 dark:text-zinc-500">…</span>}
        {visibleTools.map((p, i) => {
          const meta = getToolMeta(p);
          const hint = getToolArgHint(p as LibraryToolPart);
          const Icon = meta.icon;
          const needSep = i > 0 || truncated;
          return (
            <span
              key={`${messageId}-${p.toolCallId}`}
              className="inline-flex min-w-0 max-w-full flex-[0_1_auto] items-center gap-x-1.5"
            >
              {needSep && (
                <span className="shrink-0 text-gray-300 dark:text-zinc-600">&#8594;</span>
              )}
              <ToolChipFadeIn>
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate font-medium">{meta.label}</span>
                {hint && (
                  <span className="min-w-0 truncate text-gray-400 dark:text-zinc-500">{hint}</span>
                )}
              </ToolChipFadeIn>
            </span>
          );
        })}
        {hasInProgress ? (
          <span className="ml-0.5 h-2 w-2 animate-pulse rounded-full bg-amber-400 dark:bg-amber-300" />
        ) : null}
      </div>
    );
  };

  const renderLibraryArtifactTools = (parts: UIMessage['parts']) => {
    const artifactPayloads = parts
      .filter(isToolUIPart)
      .filter(
        part =>
          part.type === 'tool-getLearningArtifacts' || part.type === 'tool-generateLearningArtifact'
      )
      .flatMap(part => libraryArtifactPayloadsByToolCallId[part.toolCallId] || []);

    if (artifactPayloads.length === 0) {
      return null;
    }

    return (
      <ChatArtifactRenderer
        artifacts={artifactPayloads}
        isDarkMode={isDarkMode}
        openArtifactIdOverride={libraryArtifactPreviewIdOverride}
        portalContainer={libraryArtifactPortalContainer}
        onRegenerateArtifact={onLibraryArtifactRegenerate}
        onReplaceArtifact={onLibraryArtifactReplace}
      />
    );
  };

  const renderLearningArtifactNoteRequests = (parts: UIMessage['parts'], messageId: string) => {
    const noteRequests = parts
      .filter(isToolUIPart)
      .filter(part => part.type === 'tool-requestSaveLearningArtifactNote');

    if (noteRequests.length === 0) {
      return null;
    }

    return (
      <div className="space-y-2">
        {noteRequests.map(part => {
          const inputValue = isRequestSaveLearningArtifactNoteInput(part.input) ? part.input : null;
          const outputValue =
            part.output && typeof part.output === 'object'
              ? (part.output as { approved?: boolean; error?: string; saved?: boolean })
              : null;

          return (
            <div
              key={`${messageId}-${part.toolCallId}`}
              className="max-w-[88%] rounded-[1.2rem] border border-stone-200 bg-[#fbf7ef] px-4 py-3 text-sm text-stone-700 shadow-[0_12px_28px_-22px_rgba(46,34,16,0.55)] dark:border-stone-500/80 dark:bg-stone-800 dark:text-stone-200"
            >
              <div className="flex items-center gap-2 font-semibold text-stone-900 dark:text-stone-100">
                <FileText className="h-4 w-4" />
                <span>{t('Vuoi salvarlo nelle note della lezione?')}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
                {inputValue?.rationale ||
                  t('Preparo la nota di lezione con gli artefatti allegati.')}
              </p>
              {inputValue ? (
                <p className="mt-3 whitespace-pre-wrap rounded-[0.9rem] bg-white/70 px-3 py-2 text-sm leading-6 text-stone-700 dark:bg-stone-900/40 dark:text-stone-200">
                  {inputValue.noteDraft}
                </p>
              ) : null}
              {part.state === 'input-available' && inputValue ? (
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => onLibraryArtifactNoteReject(part.toolCallId)}
                    className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-100"
                  >
                    {t('No grazie')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void onLibraryArtifactNoteApprove(part.toolCallId, inputValue);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-3 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {t('Salva nota')}
                  </button>
                </div>
              ) : outputValue?.saved ? (
                <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-900/50 dark:text-stone-200">
                  <Check className="h-3.5 w-3.5" />
                  <span>{t('Nota salvata.')}</span>
                </div>
              ) : outputValue?.approved === false ? (
                <div className="mt-3 text-xs font-semibold text-stone-500 dark:text-stone-400">
                  {t('Richiesta rifiutata.')}
                </div>
              ) : outputValue?.error ? (
                <div className="mt-3 rounded-full bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:bg-red-950/30 dark:text-red-200">
                  {outputValue.error}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const renderEmptyState = () => {
    if (homeChatMode === 'new-course') {
      return (
        <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
          <p className="font-serif text-xl text-gray-400 dark:text-zinc-500 sm:text-2xl">
            {t('Cosa vorresti imparare?')}
          </p>
          <p className="mt-2 max-w-xl text-sm text-gray-500 dark:text-zinc-400">
            {t(
              "Descrivi l'obiettivo del corso oppure allega un materiale sorgente e dimmi dove vuoi arrivare."
            )}
          </p>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
        <p className="font-serif text-xl text-gray-400 dark:text-zinc-500 sm:text-2xl">
          {t('Interroga la tua libreria')}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-gray-500 dark:text-zinc-400">
          {t('Chiedi riassunti, progresso, note, highlight o confronti tra corsi.')}
        </p>
      </div>
    );
  };

  const renderLocalSourceUploadAction = () => (
    <button
      type="button"
      onClick={() => {
        closeMenus();
        onUploadSourceClick();
      }}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-orange-50 active:bg-orange-100 dark:hover:bg-orange-500/10 dark:active:bg-orange-500/15"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-200">
        <FileUp className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-gray-900 dark:text-zinc-100">
          {t('Allega file per un nuovo corso')}
        </span>
        <span className="block text-xs text-gray-500 dark:text-zinc-400">
          {t('Allega un file sorgente (PDF, ZIP, testo)')}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
    </button>
  );

  const renderDesktopAttachmentMenu = () => (
    <div
      ref={attachmentMenuRef}
      className={`absolute z-30 hidden w-[22rem] overflow-hidden rounded-[1.4rem] border border-gray-200 bg-white/95 shadow-[0_28px_80px_-40px_rgba(24,24,27,0.42)] backdrop-blur md:block dark:border-zinc-600 dark:bg-stone-800/95 ${
        attachmentMenuVerticalPlacement === 'above'
          ? 'bottom-[calc(100%+0.75rem)]'
          : 'top-[calc(100%+0.75rem)]'
      } ${attachmentMenuAlign === 'end' ? 'right-0' : 'left-0'}`}
      role="menu"
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-zinc-700/70">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
            {t('Contesto libreria')}
          </p>
          <p className="text-xs text-gray-500 dark:text-zinc-400">
            {t('Seleziona cartelle e corsi da allegare.')}
          </p>
        </div>
        <button
          type="button"
          onClick={closeMenus}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
          title={t('Chiudi selettore contesto')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="border-b border-gray-100 p-2 dark:border-zinc-700/70">
        {renderLocalSourceUploadAction()}
      </div>
      <div className="p-2 pr-1.5">
        <div className="custom-scrollbar max-h-[22rem] overflow-y-auto pr-2">
          {isLibraryLoading ? (
            <div className="px-3 py-6 text-sm text-gray-500 dark:text-zinc-400">
              {t('Caricamento libreria...')}
            </div>
          ) : libraryTree.rootNodes.length > 0 ? (
            libraryTree.rootNodes.map(node => renderAttachmentTreeNode(node))
          ) : (
            <div className="px-3 py-6 text-sm text-gray-500 dark:text-zinc-400">
              {t('Nessun corso disponibile da allegare.')}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderMobileAttachmentSheet = () => (
    <div
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      className="fixed inset-0 z-[55] flex items-end bg-black/30 p-3 md:hidden"
      onClick={event => {
        if (event.target === event.currentTarget) closeMenus();
      }}
      onKeyDown={event => {
        if (event.key === 'Escape') closeMenus();
      }}
    >
      <div className="w-full rounded-[1.8rem] border border-gray-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-zinc-500">
              {t('Allega contesto')}
            </p>
            <h4 className="mt-1 text-lg font-semibold text-gray-900 dark:text-zinc-100">
              {t('Contesto libreria')}
            </h4>
          </div>

          <button
            type="button"
            onClick={closeMenus}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-4 rounded-2xl border border-orange-200 bg-orange-50/70 p-1 dark:border-orange-500/25 dark:bg-orange-500/10">
          {renderLocalSourceUploadAction()}
        </div>

        <div className="custom-scrollbar mr-1 max-h-[52vh] overflow-y-auto pr-3">
          {isLibraryLoading ? (
            <div className="px-1 py-6 text-sm text-gray-500 dark:text-zinc-400">
              {t('Caricamento libreria...')}
            </div>
          ) : libraryTree.rootNodes.length > 0 ? (
            libraryTree.rootNodes.map(node => renderAttachmentTreeNode(node))
          ) : (
            <div className="px-1 py-6 text-sm text-gray-500 dark:text-zinc-400">
              {t('Nessun corso disponibile da allegare.')}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <section
      className={`relative rounded-[2rem] bg-[rgba(248,245,240,0.96)] shadow-[inset_0_1px_3px_rgba(24,24,27,0.05),inset_0_0_0_1px_rgba(88,64,32,0.04)] dark:bg-[rgba(46,40,36,0.94)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] max-md:flex max-md:flex-col ${hasActiveChat ? 'max-md:h-[75dvh] max-md:overflow-hidden' : ''}`}
      style={mobileChatStyle}
    >
      {showClearChat ? (
        <button
          type="button"
          onClick={() =>
            homeChatMode === 'new-course' ? onCancelNewCourse?.() : onClearLibraryMessages?.()
          }
          disabled={isLoading}
          className="absolute right-3 top-3 z-10 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-300/80 bg-white text-gray-500 shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-gray-400 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500 disabled:cursor-not-allowed disabled:opacity-50 sm:right-4 sm:top-4 dark:border-white/10 dark:bg-stone-900/80 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-100 dark:focus-visible:ring-stone-300"
          title={
            homeChatMode === 'new-course' ? t('Annulla creazione corso') : t('Pulisci questa chat')
          }
          aria-label={
            homeChatMode === 'new-course' ? t('Annulla creazione corso') : t('Pulisci questa chat')
          }
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}

      {showHeader ? (
        <div className="rounded-t-[2rem] border-b border-gray-200/55 py-4 pl-5 pr-16 dark:border-zinc-700/40 sm:pl-6 sm:pr-20">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            {!hideHeaderCopy ? (
              <div data-testid="home-chat-mode-copy" className="min-h-[6rem] sm:min-h-[4.5rem]">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="font-serif text-2xl text-gray-900 dark:text-zinc-100">
                    {homeChatMode === 'new-course'
                      ? t('Imposta un nuovo corso')
                      : t('Consulta la tua libreria')}
                  </h2>
                </div>
                <p className="mt-1.5 max-w-2xl text-sm leading-6 text-gray-600 dark:text-zinc-400">
                  {homeChatMode === 'new-course'
                    ? t(
                        'Bastano poche righe: obiettivo, livello di partenza, scadenza e materiale disponibile.'
                      )
                    : t('Interroga corsi, lezioni, note e highlight della libreria.')}
                </p>
              </div>
            ) : (
              <div />
            )}

            <div className="flex self-start items-center gap-2">
              {!hideModeSelector ? (
                <div
                  className="relative inline-flex rounded-full border border-gray-300/80 bg-white p-1 shadow-[0_1px_2px_rgba(24,24,27,0.04)] dark:border-white/10 dark:bg-stone-900/80"
                  role="tablist"
                  aria-label={t('Modalità home chat')}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={homeChatMode === 'new-course'}
                    onClick={() => handleModeChange('new-course')}
                    className={`relative inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition-colors sm:gap-2 sm:px-5 sm:py-2.5 sm:text-sm ${
                      homeChatMode === 'new-course'
                        ? 'text-white dark:text-stone-900'
                        : 'text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-100'
                    }`}
                  >
                    {homeChatMode === 'new-course' ? (
                      <motion.span
                        layoutId="home-chat-mode-pill"
                        className="absolute inset-0 rounded-full bg-stone-900 dark:bg-stone-100"
                        transition={{ duration: 0.15, ease: [0.2, 0.85, 0.25, 1] }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="relative z-10 inline-flex items-center gap-1.5 sm:gap-2">
                      <BookPlus className="h-4 w-4" />
                      {t('Nuovo corso')}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={homeChatMode === 'library-query'}
                    onClick={() => handleModeChange('library-query')}
                    className={`relative inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition-colors sm:gap-2 sm:px-5 sm:py-2.5 sm:text-sm ${
                      homeChatMode === 'library-query'
                        ? 'text-white dark:text-stone-900'
                        : 'text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-100'
                    }`}
                  >
                    {homeChatMode === 'library-query' ? (
                      <motion.span
                        layoutId="home-chat-mode-pill"
                        className="absolute inset-0 rounded-full bg-stone-900 dark:bg-stone-100"
                        transition={{ duration: 0.15, ease: [0.2, 0.85, 0.25, 1] }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="relative z-10 inline-flex items-center gap-1.5 sm:gap-2">
                      <Folder className="h-4 w-4" />
                      {t('Consulta libreria')}
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div
        ref={node => {
          messagesScrollRef.current = node;
        }}
        className={`home-chat-scrollbar overflow-y-auto px-4 sm:px-5 max-md:min-h-0 max-md:flex-1 ${
          compactWhenEmpty && !hasMessages && !isLoading
            ? 'hidden h-0 py-0'
            : `h-[14rem] md:h-[24rem] ${reserveClearButtonSpace ? 'pb-4 pt-16' : 'py-4'}`
        }`}
        style={scrollProgressOverride === undefined ? undefined : { overflowY: 'hidden' }}
      >
        <div
          className={`space-y-3.5 ${scrollProgressOverride === undefined ? '' : 'pb-20'}`}
          style={
            scrollProgressOverride === undefined
              ? undefined
              : { transform: `translateY(-${scrollOffsetOverride}px)` }
          }
        >
          {!hasMessages ? renderEmptyState() : null}

          {homeChatMode === 'new-course'
            ? assessmentMessages.map((message, index) => (
                <div
                  key={assessmentMessageKeys[index]}
                  className="flex items-start justify-start gap-2.5"
                >
                  {message.role === 'model' ? assistantAvatar : userAvatar}
                  <div
                    className={`max-w-[min(82%,76ch)] rounded-2xl px-4 py-3 text-sm leading-6 ${
                      message.role === 'user'
                        ? 'user-chat-bubble rounded-tl-md bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                        : 'rounded-tl-md border border-stone-200/80 bg-white/80 text-gray-800 shadow-sm dark:border-white/10 dark:bg-white/[0.055] dark:text-zinc-100'
                    }`}
                  >
                    <MarkdownRenderer
                      content={message.text.replace('[ASSESSMENT_COMPLETE]', '')}
                      isDarkMode={isDarkMode}
                      className={
                        message.role === 'user'
                          ? 'prose-sm prose-invert max-w-none'
                          : 'prose-sm max-w-none dark:prose-invert'
                      }
                    />
                  </div>
                </div>
              ))
            : visibleLibraryTurns.map(turn => {
                if (!isLibraryAssistantTurn(turn)) {
                  return (
                    <div key={turn.id} className="flex items-start justify-start gap-2.5">
                      {userAvatar}
                      <div className="user-chat-bubble max-w-[min(82%,76ch)] rounded-2xl rounded-tl-md bg-stone-900 px-4 py-3 text-sm leading-6 text-white dark:bg-stone-100 dark:text-stone-900">
                        <MarkdownRenderer
                          content={getUiMessageText(turn)}
                          isDarkMode={isDarkMode}
                          className="prose-sm prose-invert max-w-none"
                        />
                      </div>
                    </div>
                  );
                }

                const mergedAssistantText = getMergedLibraryAssistantText(turn.messages);

                return (
                  <div key={turn.key} className="!mt-5 flex items-start gap-2.5">
                    {assistantAvatar}
                    <div className="min-w-0 flex-1 space-y-2.5">
                      {renderLibraryToolStrip(turn.parts, turn.key)}
                      {mergedAssistantText ? (
                        <div
                          data-testid="library-assistant-turn-bubble"
                          className="max-w-[min(86%,82ch)] rounded-2xl rounded-tl-md border border-stone-200/80 bg-white/80 px-4 py-3 text-sm leading-7 text-gray-800 shadow-sm dark:border-white/10 dark:bg-white/[0.055] dark:text-zinc-100"
                        >
                          <StreamingMarkdownRenderer
                            content={mergedAssistantText.text}
                            isStreaming={mergedAssistantText.isStreaming}
                            isDarkMode={isDarkMode}
                            className="prose-sm max-w-none dark:prose-invert"
                          />
                        </div>
                      ) : null}
                      {renderLibraryArtifactTools(turn.parts)}
                      {renderLearningArtifactNoteRequests(turn.parts, turn.key)}
                    </div>
                  </div>
                );
              })}

          {homeChatMode === 'library-query' && libraryFloatingArtifactPayloads.length > 0 ? (
            <ChatArtifactRenderer
              artifacts={libraryFloatingArtifactPayloads}
              isDarkMode={isDarkMode}
              onRegenerateArtifact={onLibraryArtifactRegenerate}
              onReplaceArtifact={onLibraryArtifactReplace}
            />
          ) : null}

          {homeChatMode === 'new-course' && isLoading ? (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50/80 px-4 py-3 text-sm text-gray-600 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin text-orange-500" />
                {newCourseLoadingStatus}
              </div>
            </div>
          ) : null}

          {isLibraryAwaitingFirstResponse ? (
            <div className="flex justify-start">
              <div className="flex items-center gap-1.5 border-l border-stone-300/80 pl-3.5 py-2 text-xs text-gray-400 dark:border-stone-600/80 dark:text-zinc-500">
                <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-gray-400 dark:bg-zinc-500" />
                <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-gray-400 [animation-delay:150ms] dark:bg-zinc-500" />
                <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-gray-400 [animation-delay:300ms] dark:bg-zinc-500" />
              </div>
            </div>
          ) : null}

          {homeChatMode === 'library-query' && libraryErrorMessage ? (
            <div className="rounded-2xl border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              {libraryErrorMessage}
            </div>
          ) : null}

          {homeChatMode === 'new-course' && assessmentComplete && !isLoading ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-amber-200/80 bg-amber-50/60 px-5 py-4 dark:border-amber-700/40 dark:bg-amber-950/20">
              <p className="text-center text-sm font-medium text-amber-800 dark:text-amber-200">
                {t('Ho raccolto tutte le informazioni necessarie. Vuoi generare il corso?')}
              </p>
              <div className="flex items-center gap-3">
                <button
                  data-home-chat-target="confirm-generate"
                  type="button"
                  onClick={onConfirmGenerate}
                  className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
                >
                  <Sparkles className="h-4 w-4" />
                  {t('Sì, genera il corso')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onContinueAssessment?.();
                    inputRef.current?.focus();
                  }}
                  className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 dark:border-zinc-600 dark:bg-stone-700 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-stone-600"
                >
                  {t('No, voglio aggiungere...')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div
        ref={surfaceRootRef}
        className="border-t border-gray-100 px-4 pb-4 pt-3 dark:border-zinc-700/50 sm:px-5 max-md:shrink-0"
      >
        {homeChatMode === 'new-course' && displayedPendingFileNames.length > 0 ? (
          <div className="mb-3 flex items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-sm text-gray-600 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-300">
            <div className="flex min-w-0 items-start gap-2">
              <Paperclip className="h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <span className="font-medium">
                  {displayedPendingFileNames.length === 1
                    ? displayedPendingFileNames[0]
                    : t('{count} fonti selezionate', {
                        count: displayedPendingFileNames.length,
                      })}
                </span>
                {displayedPendingFileNames.length > 1 ? (
                  <ul className="mt-1 space-y-0.5 text-xs text-gray-500 dark:text-zinc-400">
                    {displayedPendingFiles.map(file => (
                      <li key={file.key} className="truncate">
                        {file.name}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
            {assessmentMessages.length === 0 ? (
              <button
                type="button"
                onClick={onClearPendingFile}
                className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-stone-600 dark:hover:text-zinc-100"
                title={t('Rimuovi allegato')}
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="relative">
          <form
            onSubmit={handleSubmit}
            className="relative flex items-center gap-1.5 rounded-2xl border border-gray-300 bg-white px-2 py-1.5 transition-colors focus-within:border-gray-400 dark:border-zinc-600/60 dark:bg-stone-700/60 dark:focus-within:border-zinc-500 dark:focus-within:bg-stone-700"
          >
            <button
              ref={attachmentButtonRef}
              data-home-chat-target="attachment"
              type="button"
              onClick={() => {
                if (homeChatMode === 'new-course') {
                  onUploadSourceClick();
                  return;
                }

                setActiveSurface(currentValue =>
                  currentValue === 'attachment-menu' ? null : 'attachment-menu'
                );
              }}
              disabled={homeChatMode === 'new-course' ? assessmentMessages.length > 0 : false}
              className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-gray-200/60 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-45 dark:text-zinc-500 dark:hover:bg-zinc-600/60 dark:hover:text-zinc-300"
              title={
                homeChatMode === 'new-course'
                  ? t('Allega un file sorgente (PDF, ZIP, testo)')
                  : t('Apri esploratore contesto libreria')
              }
              aria-haspopup={homeChatMode === 'library-query' ? 'menu' : undefined}
              aria-expanded={
                homeChatMode === 'library-query' && activeSurface === 'attachment-menu'
              }
            >
              <Paperclip className="h-[1.1rem] w-[1.1rem]" />
              {homeChatMode === 'library-query' && attachedContextProjectIds.size > 0 ? (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#b45c28] px-1 text-[0.6rem] font-semibold leading-none text-white dark:bg-[#e4a477] dark:text-stone-950">
                  {attachedContextProjectIds.size}
                </span>
              ) : null}
            </button>

            {homeChatMode === 'library-query' ? (
              <button
                ref={toolMenuButtonRef}
                type="button"
                onClick={() =>
                  setActiveSurface(currentValue =>
                    currentValue === 'tool-menu' ? null : 'tool-menu'
                  )
                }
                className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
                  libraryWebSearch || libraryGenerateArtifacts
                    ? 'bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-500/15 dark:text-orange-200 dark:hover:bg-orange-500/25'
                    : 'text-gray-400 hover:bg-gray-200/60 hover:text-gray-600 dark:text-zinc-500 dark:hover:bg-zinc-600/60 dark:hover:text-zinc-300'
                }`}
                title={t('Apri strumenti libreria')}
                aria-expanded={activeSurface === 'tool-menu'}
                aria-haspopup="menu"
              >
                <Plus className="h-[1.1rem] w-[1.1rem]" />
                {activeLibraryToolCount > 0 ? (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#b45c28] px-1 text-[0.6rem] font-semibold leading-none text-white dark:bg-[#e4a477] dark:text-stone-950">
                    {activeLibraryToolCount}
                  </span>
                ) : null}
              </button>
            ) : null}

            <input
              ref={inputRef}
              data-home-chat-target="objective"
              type="text"
              value={currentDraft}
              onChange={event => handleDraftChange(event.target.value)}
              onFocus={() => {
                if (isMobileViewport && inputRef.current) {
                  globalThis.window.requestAnimationFrame(() => {
                    inputRef.current?.scrollIntoView({ block: 'nearest' });
                  });
                }
              }}
              placeholder={
                inputPlaceholder ||
                (homeChatMode === 'new-course'
                  ? assessmentComplete
                    ? t('Aggiungi dettagli o requisiti...')
                    : t(
                        "Descrivi l'obiettivo del corso o allega un file: cosa prepari, livello attuale, scadenza..."
                      )
                  : t('Chiedi progressi, riassunti, note o confronti tra corsi...'))
              }
              className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              disabled={isLoading}
            />

            <SpeechInputButton
              disabled={isLoading}
              onTranscription={handleSpeechTranscription}
              variant="compact"
            />
            <button
              type="submit"
              data-home-chat-target="submit"
              disabled={isLoading || !currentDraft.trim()}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
                isLoading
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-900 text-white hover:bg-black disabled:bg-gray-200 disabled:text-gray-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500'
              }`}
              title={t(homeChatMode === 'new-course' ? 'Inizia' : 'Invia domanda libreria')}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>

            {homeChatMode === 'library-query' &&
            activeSurface === 'tool-menu' &&
            !isMobileViewport ? (
              <div
                ref={toolMenuRef}
                className={`absolute z-30 w-[19rem] overflow-hidden rounded-[1.4rem] border border-gray-200 bg-white/95 p-2 shadow-[0_28px_80px_-40px_rgba(24,24,27,0.42)] backdrop-blur dark:border-zinc-600 dark:bg-stone-800/95 ${
                  toolMenuVerticalPlacement === 'above'
                    ? 'bottom-[calc(100%+0.75rem)]'
                    : 'top-[calc(100%+0.75rem)]'
                } ${toolMenuAlign === 'end' ? 'right-0' : 'left-0'}`}
                role="menu"
              >
                <button
                  type="button"
                  onClick={() => onLibraryWebSearchChange(!libraryWebSearch)}
                  className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/80"
                  role="menuitemcheckbox"
                  aria-checked={libraryWebSearch}
                >
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                      libraryWebSearch
                        ? 'border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-stone-900'
                        : 'border-gray-300 text-transparent dark:border-zinc-500'
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-zinc-100">
                      <Globe className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
                      {t('Cerca sul web')}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                      {t(
                        'Aggiunge grounding esterno quando servono confronti, suggerimenti di corsi o dati aggiornati.'
                      )}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onLibraryGenerateArtifactsChange(!libraryGenerateArtifacts)}
                  className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/80"
                  role="menuitemcheckbox"
                  aria-checked={libraryGenerateArtifacts}
                >
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                      libraryGenerateArtifacts
                        ? 'border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-stone-900'
                        : 'border-gray-300 text-transparent dark:border-zinc-500'
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-zinc-100">
                      <Sparkles className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
                      {t('Genera artefatti visuali')}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                      {t(
                        'Crea automaticamente mappe, grafici, diagrammi e widget per visualizzare i concetti trattati.'
                      )}
                    </span>
                  </span>
                </button>
              </div>
            ) : null}
          </form>

          {homeChatMode === 'library-query' &&
          activeSurface === 'attachment-menu' &&
          !isMobileViewport
            ? renderDesktopAttachmentMenu()
            : null}
        </div>

        {homeChatMode === 'library-query' && activeSurface === 'tool-menu' && isMobileViewport ? (
          <div
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            className="fixed inset-0 z-[55] flex items-end bg-black/30 p-3 md:hidden"
            onClick={event => {
              if (event.target === event.currentTarget) closeMenus();
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') closeMenus();
            }}
          >
            <div className="w-full rounded-[1.8rem] border border-gray-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-zinc-500">
                    {t('Strumenti libreria')}
                  </p>
                  <h4 className="mt-1 text-lg font-semibold text-gray-900 dark:text-zinc-100">
                    {t('Preferenze risposta')}
                  </h4>
                </div>
                <button
                  type="button"
                  onClick={closeMenus}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <button
                type="button"
                onClick={() => onLibraryWebSearchChange(!libraryWebSearch)}
                className="flex w-full items-start gap-3 rounded-[1.2rem] border border-gray-200 px-4 py-4 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                    libraryWebSearch
                      ? 'border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-stone-900'
                      : 'border-gray-300 text-transparent dark:border-zinc-500'
                  }`}
                >
                  <Check className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-zinc-100">
                    <Globe className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
                    {t('Cerca sul web')}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                    {t(
                      'Da usare insieme ai dati della libreria quando vuoi confronti o suggerimenti oltre la libreria.'
                    )}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onLibraryGenerateArtifactsChange(!libraryGenerateArtifacts)}
                className="mt-3 flex w-full items-start gap-3 rounded-[1.2rem] border border-gray-200 px-4 py-4 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                    libraryGenerateArtifacts
                      ? 'border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-stone-900'
                      : 'border-gray-300 text-transparent dark:border-zinc-500'
                  }`}
                >
                  <Check className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-zinc-100">
                    <Sparkles className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
                    {t('Genera artefatti visuali')}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                    {t(
                      'Crea mappe, grafici e diagrammi per visualizzare i concetti insieme alle risposte.'
                    )}
                  </span>
                </span>
              </button>
            </div>
          </div>
        ) : null}

        {homeChatMode === 'library-query' && activeSurface === 'attachment-menu' && isMobileViewport
          ? renderMobileAttachmentSheet()
          : null}
      </div>
    </section>
  );
}
