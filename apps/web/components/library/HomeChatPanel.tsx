import { isToolUIPart, type UIMessage } from 'ai';
import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  BookPlus,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
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
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { usePersistedLibraryFolderExpansion } from '../../hooks/library/usePersistedLibraryFolderExpansion.ts';
import type {
  HomeChatMode,
  LibraryContextRef,
  LibraryScopeSummary,
  LibraryTree,
  LibraryTreeNode,
  Message,
} from '../../types.ts';
import {
  dedupeUiMessagesById,
  getUiMessageRenderableParts,
  getUiMessageText,
} from '../../utils/uiChat.ts';
import MarkdownRenderer from '../shared/MarkdownRenderer.tsx';
import StreamingMarkdownRenderer from '../shared/StreamingMarkdownRenderer.tsx';

interface HomeChatPanelProps {
  assessmentComplete: boolean;
  assessmentMessages: Message[];
  homeChatMode: HomeChatMode;
  isDarkMode: boolean;
  isLibraryLoading: boolean;
  isLibraryModeLoading: boolean;
  isNewCourseLoading: boolean;
  libraryAttachedContextRefs: LibraryContextRef[];
  libraryErrorMessage: string | null;
  libraryMessages: UIMessage[];
  libraryScopeSummary: LibraryScopeSummary;
  libraryTree: LibraryTree;
  libraryWebSearch: boolean;
  newCourseLoadingStatus: string;
  pendingFileName: string | null;
  onClearPendingFile: () => void;
  onClearLibraryMessages?: () => void;
  onConfirmGenerate: () => void;
  onHomeChatModeChange: (mode: HomeChatMode) => void;
  onLibraryMessageSend: (message: string) => void | Promise<void>;
  onLibraryWebSearchChange: (value: boolean) => void;
  onRemoveLibraryContextRef: (reference: LibraryContextRef) => void;
  onSendAssessmentMessage: (message: string) => Promise<void>;
  onToggleLibraryContextRef: (reference: LibraryContextRef) => void;
  onUploadSourceClick: () => void;
}

type SurfaceState = null | 'attachment-menu' | 'tool-menu';
type AttachmentStep = 'root' | 'picker';
type MenuAlign = 'start' | 'end';
type SubmenuSide = 'left' | 'right';
type LibraryToolPart = Extract<UIMessage['parts'][number], { type: `tool-${string}` }>;

const readIsMobileViewport = () =>
  typeof window !== 'undefined' ? window.innerWidth < 768 : false;

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

const LIBRARY_TOOL_META: Record<string, { icon: LucideIcon; label: string }> = {
  getLessonDetails: { icon: FileText, label: 'Dettagli lezioni' },
  getProjectOverviews: { icon: BookOpen, label: 'Panoramica corsi' },
  getProjectStructures: { icon: GitFork, label: 'Struttura corsi' },
  listLibraryTree: { icon: List, label: 'Indice libreria' },
  searchLibrary: { icon: Search, label: 'Ricerca contenuti' },
  searchWeb: { icon: Globe, label: 'Ricerca web' },
};

const FALLBACK_TOOL_META = { icon: Search, label: 'Tool' };

const getToolMeta = (part: UIMessage['parts'][number]) => {
  if (!isToolUIPart(part)) return FALLBACK_TOOL_META;
  const raw =
    'toolName' in part && typeof part.toolName === 'string'
      ? part.toolName
      : part.type.startsWith('tool-')
        ? part.type.slice(5)
        : '';
  return (
    LIBRARY_TOOL_META[raw] || {
      icon: Search,
      label: raw.replace(/([A-Z])/g, ' $1').trim() || 'Tool',
    }
  );
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
      return ids.length === 1 ? '1 corso' : `${ids.length} corsi`;
    }
    case 'getLessonDetails': {
      const reqs = input.requests as Array<{ lessonIds?: string[] }> | undefined;
      if (!reqs) return null;
      const count = reqs.reduce((sum, r) => sum + (r.lessonIds?.length ?? 0), 0);
      return count === 0 ? null : count === 1 ? '1 lezione' : `${count} lezioni`;
    }
    case 'searchLibrary':
    case 'searchWeb': {
      const query = input.query as string | undefined;
      if (!query) return null;
      return query.length > 30 ? `${query.slice(0, 30)}\u2026` : query;
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
      className="inline-flex items-center gap-x-1.5"
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
  libraryErrorMessage,
  libraryMessages,
  libraryScopeSummary,
  libraryTree,
  libraryWebSearch,
  newCourseLoadingStatus,
  pendingFileName,
  onClearPendingFile,
  onClearLibraryMessages,
  onConfirmGenerate,
  onHomeChatModeChange,
  onLibraryMessageSend,
  onLibraryWebSearchChange,
  onRemoveLibraryContextRef,
  onSendAssessmentMessage,
  onToggleLibraryContextRef,
  onUploadSourceClick,
}: HomeChatPanelProps) {
  const [draftByMode, setDraftByMode] = useState<Record<HomeChatMode, string>>({
    'library-query': '',
    'new-course': '',
  });
  const { expandedFolderIds, toggleFolderExpansion } =
    usePersistedLibraryFolderExpansion(libraryTree);
  const [activeSurface, setActiveSurface] = useState<SurfaceState>(null);
  const [attachmentStep, setAttachmentStep] = useState<AttachmentStep>('root');
  const [isMobileViewport, setIsMobileViewport] = useState(readIsMobileViewport);
  const [toolMenuAlign, setToolMenuAlign] = useState<MenuAlign>('start');
  const [attachmentMenuAlign, setAttachmentMenuAlign] = useState<MenuAlign>('start');
  const [attachmentSubmenuSide, setAttachmentSubmenuSide] = useState<SubmenuSide>('right');

  const toolMenuButtonRef = useRef<HTMLButtonElement>(null);
  const attachmentButtonRef = useRef<HTMLButtonElement>(null);
  const surfaceRootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
  const currentDraft = draftByMode[homeChatMode];
  const activeMessages =
    homeChatMode === 'new-course' ? assessmentMessages : visibleLibraryMessages;
  const hasMessages = activeMessages.length > 0;
  const isLoading = homeChatMode === 'new-course' ? isNewCourseLoading : isLibraryModeLoading;

  const isLibraryAwaitingFirstResponse =
    homeChatMode === 'library-query' &&
    isLoading &&
    !visibleLibraryMessages.some(message => message.role === 'assistant');
  const hasLibraryComposerMeta = libraryAttachedContextRefs.length > 0 || libraryWebSearch;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const updateViewport = () => {
      setIsMobileViewport(readIsMobileViewport());
    };

    updateViewport();
    window.addEventListener('resize', updateViewport);
    return () => {
      window.removeEventListener('resize', updateViewport);
    };
  }, []);

  useEffect(() => {
    const shouldResetAttachmentFlow =
      homeChatMode === 'library-query' || homeChatMode === 'new-course';

    if (!shouldResetAttachmentFlow) {
      return;
    }

    setActiveSurface(null);
    setAttachmentStep('root');
  }, [homeChatMode]);

  useEffect(() => {
    const lastItem = activeMessages[activeMessages.length - 1] || null;
    if (!lastItem && !assessmentComplete && !isLoading) {
      return;
    }

    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeMessages, assessmentComplete, isLoading]);

  useEffect(() => {
    if (isMobileViewport) {
      return;
    }
    inputRef.current?.focus();
  }, [isMobileViewport]);

  useEffect(() => {
    if (!activeSurface) {
      return;
    }

    const anchor =
      activeSurface === 'tool-menu' ? toolMenuButtonRef.current : attachmentButtonRef.current;

    const anchorRect = anchor?.getBoundingClientRect();
    if (!anchorRect) {
      return;
    }

    const align: MenuAlign = anchorRect.left > window.innerWidth * 0.62 ? 'end' : 'start';

    if (activeSurface === 'tool-menu') {
      setToolMenuAlign(align);
      return;
    }

    setAttachmentMenuAlign(align);
    const spaceOnRight = window.innerWidth - anchorRect.right;
    const spaceOnLeft = anchorRect.left;
    setAttachmentSubmenuSide(spaceOnRight >= 344 || spaceOnRight >= spaceOnLeft ? 'right' : 'left');
  }, [activeSurface]);

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
      setAttachmentStep('root');
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

  const handleModeChange = (mode: HomeChatMode) => {
    onHomeChatModeChange(mode);
  };

  const closeMenus = () => {
    setActiveSurface(null);
    setAttachmentStep('root');
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
      const isSelected = libraryAttachedContextRefs.some(
        reference => reference.id === node.id && reference.kind === 'project'
      );

      return (
        <label
          key={`project-${node.id}`}
          className="flex cursor-pointer items-start gap-3 rounded-2xl px-3 py-2 transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/70"
          style={{ paddingLeft }}
        >
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() =>
              onToggleLibraryContextRef({
                id: node.id,
                kind: 'project',
                label: node.project.title,
              })
            }
            className="mt-1 h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500 dark:border-zinc-600"
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-gray-900 dark:text-zinc-100">
              {node.project.title}
            </span>
            <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
              {node.project.completedCount}/{node.project.lessonCount} lezioni completate
            </span>
          </span>
        </label>
      );
    }

    const isExpanded = expandedFolderIds.has(node.id);
    const isSelected = libraryAttachedContextRefs.some(
      reference => reference.id === node.id && reference.kind === 'folder'
    );

    return (
      <div key={`folder-${node.id}`}>
        <div
          className="flex items-start rounded-2xl transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/70"
          style={{ paddingLeft }}
        >
          <label className="flex shrink-0 cursor-pointer py-2 pl-0 pr-2">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() =>
                onToggleLibraryContextRef({
                  id: node.id,
                  kind: 'folder',
                  label: node.folder.name,
                })
              }
              className="mt-1 h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500 dark:border-zinc-600"
            />
          </label>
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
                {node.descendantProjectIds.length} corsi inclusi
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

    const hasInProgress = toolParts.some(p => isPendingLibraryToolState(p.state));
    const maxTools = isMobileViewport ? 2 : 4;
    const truncated = toolParts.length > maxTools;
    const visibleTools = truncated ? toolParts.slice(-maxTools) : toolParts;

    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 py-1.5 text-xs text-gray-600 dark:text-zinc-300">
        {truncated && <span className="text-gray-400 dark:text-zinc-500">…</span>}
        {visibleTools.map((p, i) => {
          const meta = getToolMeta(p);
          const hint = getToolArgHint(p as LibraryToolPart);
          const Icon = meta.icon;
          const needSep = i > 0 || truncated;
          return (
            <span
              key={`${messageId}-${p.toolCallId}`}
              className="inline-flex items-center gap-x-1.5"
            >
              {needSep && <span className="text-gray-300 dark:text-zinc-600">&#8594;</span>}
              <ToolChipFadeIn>
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium">{meta.label}</span>
                {hint && <span className="text-gray-400 dark:text-zinc-500">{hint}</span>}
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

  const renderEmptyState = () => {
    if (homeChatMode === 'new-course') {
      return (
        <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
          <p className="font-serif text-xl text-gray-400 dark:text-zinc-500 sm:text-2xl">
            Cosa vorresti imparare?
          </p>
          <p className="mt-2 max-w-xl text-sm text-gray-500 dark:text-zinc-400">
            Descrivi l'obiettivo del corso oppure allega un materiale sorgente e dimmi dove vuoi
            arrivare.
          </p>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
        <p className="font-serif text-xl text-gray-400 dark:text-zinc-500 sm:text-2xl">
          Interroga la tua libreria
        </p>
        <p className="mt-2 max-w-2xl text-sm text-gray-500 dark:text-zinc-400">
          Chiedi riassunti, progresso, note, highlight o confronti tra corsi.
        </p>
      </div>
    );
  };

  const renderDesktopAttachmentMenu = () => (
    <div
      className={`absolute bottom-[calc(100%+0.75rem)] z-30 hidden md:block ${
        attachmentMenuAlign === 'end' ? 'right-0' : 'left-0'
      }`}
      role="menu"
    >
      <div className="relative">
        <div className="w-[19rem] overflow-hidden rounded-[1.4rem] border border-gray-200 bg-white/95 p-2 shadow-[0_28px_80px_-40px_rgba(24,24,27,0.42)] backdrop-blur dark:border-zinc-600 dark:bg-stone-800/95">
          <button
            type="button"
            onClick={() => setAttachmentStep('picker')}
            className="flex w-full items-center justify-between rounded-[1rem] px-3 py-3 text-left transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/70"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium text-gray-900 dark:text-zinc-100">
                Scegli corsi o cartelle
              </span>
              <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                Multi-selezione mista con cartelle annidate e corsi singoli.
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
          </button>
        </div>

        {attachmentStep === 'picker' ? (
          <div
            className={`absolute top-0 z-10 w-[21.5rem] overflow-hidden rounded-[1.4rem] border border-gray-200 bg-white/95 shadow-[0_28px_80px_-40px_rgba(24,24,27,0.42)] backdrop-blur dark:border-zinc-600 dark:bg-stone-800/95 ${
              attachmentSubmenuSide === 'left'
                ? 'right-[calc(100%+0.75rem)]'
                : 'left-[calc(100%+0.75rem)]'
            }`}
          >
            <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-zinc-700/70">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
                  Contesto libreria
                </p>
                <p className="text-xs text-gray-500 dark:text-zinc-400">
                  Seleziona cartelle e corsi da allegare.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAttachmentStep('root')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
                title="Chiudi selettore contesto"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[22rem] overflow-y-auto px-2 py-2">
              {isLibraryLoading ? (
                <div className="px-3 py-6 text-sm text-gray-500 dark:text-zinc-400">
                  Caricamento libreria...
                </div>
              ) : libraryTree.rootNodes.length > 0 ? (
                libraryTree.rootNodes.map(node => renderAttachmentTreeNode(node))
              ) : (
                <div className="px-3 py-6 text-sm text-gray-500 dark:text-zinc-400">
                  Nessun corso disponibile da allegare.
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  const renderMobileAttachmentSheet = () => (
    <div
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      className="fixed inset-0 z-40 flex items-end bg-black/30 p-3 md:hidden"
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
              Allega contesto
            </p>
            <h4 className="mt-1 text-lg font-semibold text-gray-900 dark:text-zinc-100">
              {attachmentStep === 'root' ? 'Scegli il contesto' : 'Scegli corsi o cartelle'}
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

        {attachmentStep === 'root' ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setAttachmentStep('picker')}
              className="flex w-full items-center justify-between rounded-[1.2rem] border border-gray-200 px-4 py-4 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-zinc-100">
                  Scegli corsi o cartelle
                </span>
                <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                  Apri l'esploratore contesto senza rischi di clipping laterale.
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
            </button>
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setAttachmentStep('root')}
              className="mb-3 inline-flex items-center gap-2 rounded-full px-2 py-1 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <ArrowLeft className="h-4 w-4" />
              Indietro
            </button>

            <div className="max-h-[52vh] overflow-y-auto">
              {isLibraryLoading ? (
                <div className="px-1 py-6 text-sm text-gray-500 dark:text-zinc-400">
                  Caricamento libreria...
                </div>
              ) : libraryTree.rootNodes.length > 0 ? (
                libraryTree.rootNodes.map(node => renderAttachmentTreeNode(node))
              ) : (
                <div className="px-1 py-6 text-sm text-gray-500 dark:text-zinc-400">
                  Nessun corso disponibile da allegare.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <section className="rounded-[2rem] bg-[rgba(246,244,240,0.9)] shadow-[inset_0_1px_3px_rgba(24,24,27,0.07),inset_0_0_0_1px_rgba(24,24,27,0.05)] dark:bg-[rgba(39,39,42,0.9)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
      <div className="rounded-t-[2rem] border-b border-gray-200/55 px-5 py-4 dark:border-zinc-700/40 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div data-testid="home-chat-mode-copy" className="min-h-[6rem] sm:min-h-[4.5rem]">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-serif text-2xl text-gray-900 dark:text-zinc-100">
                {homeChatMode === 'new-course'
                  ? 'Imposta un nuovo corso'
                  : 'Consulta la tua libreria'}
              </h2>
            </div>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-gray-600 dark:text-zinc-400">
              {homeChatMode === 'new-course'
                ? 'Bastano poche righe: obiettivo, livello di partenza, scadenza e materiale disponibile.'
                : 'Interroga corsi, lezioni, note e highlight locali.'}
            </p>
          </div>

          <div className="flex self-start items-center gap-2">
            {homeChatMode === 'library-query' &&
            visibleLibraryMessages.length > 0 &&
            onClearLibraryMessages ? (
              <button
                type="button"
                onClick={onClearLibraryMessages}
                disabled={isLoading}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-300/80 bg-white text-gray-500 shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-gray-400 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-stone-900/80 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
                title="Pulisci questa chat"
                aria-label="Pulisci questa chat"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            ) : null}

            <div
              className="relative inline-flex rounded-full border border-gray-300/80 bg-white p-1 shadow-[0_1px_2px_rgba(24,24,27,0.04)] dark:border-white/10 dark:bg-stone-900/80"
              role="tablist"
              aria-label="Modalità home chat"
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
                    transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.8 }}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="relative z-10 inline-flex items-center gap-1.5 sm:gap-2">
                  <BookPlus className="h-4 w-4" />
                  Nuovo corso
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
                    transition={{ type: 'spring', stiffness: 520, damping: 38, mass: 0.8 }}
                    aria-hidden="true"
                  />
                ) : null}
                <span className="relative z-10 inline-flex items-center gap-1.5 sm:gap-2">
                  <Folder className="h-4 w-4" />
                  Consulta libreria
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="h-[14rem] overflow-y-auto px-4 py-4 sm:h-[24rem] sm:px-5">
        <div className="space-y-4">
          {!hasMessages ? renderEmptyState() : null}

          {homeChatMode === 'new-course'
            ? assessmentMessages.map((message, index) => (
                <div
                  key={assessmentMessageKeys[index]}
                  className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      message.role === 'user'
                        ? 'rounded-br-md bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                        : 'rounded-bl-md border border-gray-200 bg-gray-50/80 text-gray-800 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-100'
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
                    <div key={turn.id} className="flex justify-end">
                      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-stone-900 px-4 py-3 text-sm leading-relaxed text-white dark:bg-stone-100 dark:text-stone-900">
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
                  <div key={turn.key} className="!mt-6 space-y-2">
                    {renderLibraryToolStrip(turn.parts, turn.key)}
                    {mergedAssistantText ? (
                      <div
                        data-testid="library-assistant-turn-bubble"
                        className="max-w-[88%] rounded-2xl rounded-bl-md border border-gray-200 bg-gray-50/80 px-4 py-3 text-sm leading-relaxed text-gray-800 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-100"
                      >
                        <StreamingMarkdownRenderer
                          content={mergedAssistantText.text}
                          isStreaming={mergedAssistantText.isStreaming}
                          isDarkMode={isDarkMode}
                          className="prose-sm max-w-none dark:prose-invert"
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}

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
              <div className="flex items-center gap-1.5 px-4 py-3 text-xs text-gray-400 dark:text-zinc-500">
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
                Ho raccolto tutte le informazioni necessarie. Vuoi generare il corso?
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onConfirmGenerate}
                  className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
                >
                  <Sparkles className="h-4 w-4" />
                  Sì, genera il corso
                </button>
                <button
                  type="button"
                  onClick={() => inputRef.current?.focus()}
                  className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 dark:border-zinc-600 dark:bg-stone-700 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-stone-600"
                >
                  No, voglio aggiungere...
                </button>
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div
        ref={surfaceRootRef}
        className="border-t border-gray-100 px-4 pb-4 pt-3 dark:border-zinc-700/50 sm:px-5"
      >
        {homeChatMode === 'new-course' && pendingFileName ? (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-sm text-gray-600 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-300">
            <div className="flex min-w-0 items-center gap-2">
              <Paperclip className="h-4 w-4 shrink-0" />
              <span className="truncate">{pendingFileName}</span>
            </div>
            {assessmentMessages.length === 0 ? (
              <button
                type="button"
                onClick={onClearPendingFile}
                className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-stone-600 dark:hover:text-zinc-100"
                title="Rimuovi allegato"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        ) : null}

        {homeChatMode === 'library-query' && hasLibraryComposerMeta ? (
          <div data-testid="library-chat-context-bar" className="mb-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {libraryAttachedContextRefs.map(reference => (
                <span
                  key={`${reference.kind}-${reference.id}`}
                  className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1.5 text-xs font-medium text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200"
                >
                  {reference.kind === 'folder' ? (
                    <Folder className="h-3.5 w-3.5" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  <span className="max-w-[12rem] truncate">{reference.label}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveLibraryContextRef(reference)}
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full text-orange-500 transition-colors hover:bg-orange-100 hover:text-orange-700 dark:hover:bg-orange-500/15 dark:hover:text-orange-100"
                    aria-label={`Rimuovi ${reference.label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}

              {libraryWebSearch ? (
                <span className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-stone-100/80 px-3 py-1.5 text-xs font-medium text-stone-700 dark:border-stone-500/40 dark:bg-stone-700/50 dark:text-stone-200">
                  <Globe className="h-3.5 w-3.5" />
                  Cerca sul web attiva
                </span>
              ) : null}
            </div>

            {libraryAttachedContextRefs.length > 0 ? (
              <p className="text-xs leading-5 text-gray-500 dark:text-zinc-400">
                {libraryScopeSummary.scopeSummary}
              </p>
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
              type="button"
              onClick={() => {
                if (homeChatMode === 'new-course') {
                  onUploadSourceClick();
                  return;
                }

                setActiveSurface(currentValue =>
                  currentValue === 'attachment-menu' ? null : 'attachment-menu'
                );
                setAttachmentStep('root');
              }}
              disabled={homeChatMode === 'new-course' ? assessmentMessages.length > 0 : false}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-gray-200/60 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-45 dark:text-zinc-500 dark:hover:bg-zinc-600/60 dark:hover:text-zinc-300"
              title={
                homeChatMode === 'new-course'
                  ? 'Allega un file sorgente (PDF, ZIP, testo)'
                  : 'Apri esploratore contesto libreria'
              }
              aria-haspopup={homeChatMode === 'library-query' ? 'menu' : undefined}
              aria-expanded={
                homeChatMode === 'library-query' && activeSurface === 'attachment-menu'
              }
            >
              <Paperclip className="h-[1.1rem] w-[1.1rem]" />
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
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
                  libraryWebSearch
                    ? 'bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-500/15 dark:text-orange-200 dark:hover:bg-orange-500/25'
                    : 'text-gray-400 hover:bg-gray-200/60 hover:text-gray-600 dark:text-zinc-500 dark:hover:bg-zinc-600/60 dark:hover:text-zinc-300'
                }`}
                title="Apri strumenti libreria"
                aria-expanded={activeSurface === 'tool-menu'}
                aria-haspopup="menu"
              >
                <Plus className="h-[1.1rem] w-[1.1rem]" />
              </button>
            ) : null}

            <input
              ref={inputRef}
              type="text"
              value={currentDraft}
              onChange={event => handleDraftChange(event.target.value)}
              placeholder={
                homeChatMode === 'new-course'
                  ? assessmentComplete
                    ? 'Aggiungi dettagli o requisiti...'
                    : "Descrivi l'obiettivo del corso o allega un file: cosa prepari, livello attuale, scadenza..."
                  : 'Chiedi progressi, riassunti, note o confronti tra corsi...'
              }
              className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              disabled={isLoading}
            />

            <button
              type="submit"
              disabled={isLoading || !currentDraft.trim()}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
                isLoading
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-900 text-white hover:bg-black disabled:bg-gray-200 disabled:text-gray-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500'
              }`}
              title={homeChatMode === 'new-course' ? 'Inizia' : 'Invia domanda libreria'}
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
                className={`absolute bottom-[calc(100%+0.75rem)] z-30 w-[19rem] overflow-hidden rounded-[1.4rem] border border-gray-200 bg-white/95 p-2 shadow-[0_28px_80px_-40px_rgba(24,24,27,0.42)] backdrop-blur dark:border-zinc-600 dark:bg-stone-800/95 ${
                  toolMenuAlign === 'end' ? 'right-0' : 'left-0'
                }`}
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
                      Cerca sul web
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                      Aggiunge grounding esterno quando servono confronti, suggerimenti di corsi o
                      dati aggiornati.
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
            className="fixed inset-0 z-40 flex items-end bg-black/30 p-3 md:hidden"
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
                    Strumenti libreria
                  </p>
                  <h4 className="mt-1 text-lg font-semibold text-gray-900 dark:text-zinc-100">
                    Preferenze risposta
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
                    Cerca sul web
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                    Da usare insieme ai dati locali quando vuoi confronti o suggerimenti oltre la
                    libreria.
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
