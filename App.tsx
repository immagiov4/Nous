import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { ArrowLeft, BookOpen, CheckCircle2, ChevronRight, Download, Gauge, GraduationCap, LibraryBig, MessageSquare, Moon, RefreshCw, Ruler, SidebarClose, SidebarOpen, Sun } from 'lucide-react';
import JSZip from 'jszip';
import { AppState, type ContextMenuPlacement, type ContextMenuState, type FileData, type LearningPlan, type LearningSection, type LessonImageRef, type Message, type PdfDocumentAssets, type PdfImageAsset, type PdfTextIndex, type QuizQuestion, type SyllabusItem, type UserProfile } from './types';
import * as GeminiService from './services/geminiService';
import { ASSESSMENT_MIN_TURNS } from './constants';
import AssessmentView from './components/AssessmentView';
import MarkdownRenderer from './components/MarkdownRenderer';
import ContextMenu from './components/ContextMenu';
import LoadingScreen from './components/LoadingScreen';
import AudioPlayer from './components/AudioPlayer';
import ReadingRuler from './components/ReadingRuler';
import MusicPlayer from './components/MusicPlayer';
import LibraryView from './components/LibraryView';
import { useTtsPlayer } from './hooks/useTtsPlayer.ts';
import { useProjectLibrary } from './hooks/useProjectLibrary.ts';
import { createProjectId, createProjectSnapshot } from './services/projectSnapshot';
import { getBackendUrl } from './services/gemini/config';
import {
  createClosedContextMenuState,
  resolveContextMenuSelection,
  resolveMobileContextMenuSyncAction,
} from './utils/contextMenuSelection';
import { buildReadableBlocks } from './utils/readingText';
import { toggleHighlightInContent } from './utils/highlightSelection';
import { buildProjectLocationHref, getProjectIdFromLocation } from './utils/projectLocation';
import { resolveLessonGenerationState } from './utils/lessonGenerationState';

const SIDEBAR_WIDTH_PX = 384;
const MOBILE_LAYOUT_BREAKPOINT_PX = 1024;
const CONTEXT_ANSWER_DEFAULT_WIDTH = 512;
const CONTEXT_ANSWER_DEFAULT_HEIGHT = 544;
const CONTEXT_ANSWER_MIN_WIDTH = 352;
const CONTEXT_ANSWER_MIN_HEIGHT = 256;
const CONTEXT_ANSWER_VIEWPORT_MARGIN = 32;
const CONTEXT_MENU_MOBILE_DEBOUNCE_MS = 160;

// IGNORED_DIRS: We still filter these to avoid noise and massive performance hits
// from dependencies or build artifacts, even if they contain text.
const IGNORED_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 
  '.idea', '.vscode', '__pycache__', 'bin', 'obj', '.vs', 
  'vendor', 'packages'
];

// Heuristic to detect binary files by checking for null bytes in the first chunk
const isBinaryFile = (uint8Array: Uint8Array): boolean => {
  // Check the first 1024 bytes (or less)
  const checkLength = Math.min(uint8Array.length, 1024);
  
  for (let i = 0; i < checkLength; i++) {
    // 0x00 is the null byte. Its presence almost always indicates a binary file 
    // (images, compiled code, etc.) rather than source code.
    if (uint8Array[i] === 0) {
      return true;
    }
  }
  return false;
};

interface SidebarGroup {
  id: string;
  title: string;
  sections: LearningSection[];
}

interface ChatSession {
  sendMessage: (params: { message: string }) => Promise<{
    text: string;
    functionCalls?: Array<{ name: string; args: unknown }>;
  }>;
}

interface ContextAnswerState {
  q: string;
  a: string;
}

interface ContextAnswerSize {
  width: number;
  height: number;
}

interface ContextAnswerResizeState {
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

interface LoadSectionOptions {
  forceRegenerate?: boolean;
  context?: Partial<LoadSectionRuntimeContext>;
}

interface LoadSectionRuntimeContext {
  documentAssets: PdfDocumentAssets | null;
  file: FileData | null;
  isLearnMode: boolean;
  syllabus: SyllabusItem[];
  userProfile: UserProfile | null;
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
};

const buildSidebarGroups = (
  learningPlan: LearningPlan | null,
  syllabus: SyllabusItem[]
): SidebarGroup[] => {
  if (!learningPlan || learningPlan.sections.length === 0) return [];

  const sectionById = new Map(learningPlan.sections.map(section => [section.id, section]));
  const moduleTitleById = new Map(syllabus.map(module => [module.id, module.title]));
  const moduleIdBySectionId = new Map<string, string>();

  syllabus.forEach((module) => {
    (module.children || []).forEach((lesson) => {
      moduleIdBySectionId.set(lesson.id, module.id);
    });
  });

  const resolveModuleId = (sectionId: string): string | null => {
    const visited = new Set<string>();
    let currentId: string | undefined = sectionId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);

      const directModuleId = moduleIdBySectionId.get(currentId);
      if (directModuleId) {
        return directModuleId;
      }

      const currentSection = sectionById.get(currentId);
      currentId = currentSection?.parentId;
    }

    return null;
  };

  const groupedSections = new Map<string, LearningSection[]>();
  const fallbackGroupTitleByKey = new Map<string, string>();
  const groupOrder: string[] = syllabus.map(module => module.id);

  const getFallbackGroupTitle = (section: LearningSection): string =>
    section.moduleTitle?.trim() ||
    (section.type === 'prerequisite'
      ? 'Prerequisiti'
      : section.type === 'summary'
        ? 'Sintesi'
        : 'Percorso');

  learningPlan.sections.forEach((section) => {
    const resolvedModuleId = resolveModuleId(section.id);
    const fallbackTitle = getFallbackGroupTitle(section);
    const fallbackGroupKey = section.parentId || `group:${fallbackTitle}`;
    const groupKey = resolvedModuleId || fallbackGroupKey || '__ungrouped__';

    if (!groupedSections.has(groupKey)) {
      groupedSections.set(groupKey, []);
      if (!groupOrder.includes(groupKey)) {
        groupOrder.push(groupKey);
      }
    }

    if (!resolvedModuleId && !fallbackGroupTitleByKey.has(groupKey)) {
      fallbackGroupTitleByKey.set(groupKey, fallbackTitle);
    }

    groupedSections.get(groupKey)?.push(section);
  });

  const groups = groupOrder
    .map((groupKey, index) => {
      const sections = groupedSections.get(groupKey) || [];
      if (sections.length === 0) {
        return null;
      }

      const isUngrouped = groupKey === '__ungrouped__';

      return {
        id: isUngrouped ? `group-${index}` : groupKey,
        title:
          moduleTitleById.get(groupKey) ||
          fallbackGroupTitleByKey.get(groupKey) ||
          (isUngrouped ? 'Percorso' : `Modulo ${index + 1}`),
        sections,
      };
    })
    .filter((group): group is SidebarGroup => Boolean(group));

  return groups.length > 0 ? groups : [{ id: 'group-0', title: 'Percorso', sections: learningPlan.sections }];
};

const resolveLearnSectionContext = (
  section: LearningSection,
  learningPlan: LearningPlan | null,
  syllabus: SyllabusItem[]
): {
  anchorLessonId: string;
  anchorLessonContextPrompt?: string;
  moduleId: string;
  moduleTitle: string;
} => {
  const sectionById = new Map(learningPlan?.sections.map(item => [item.id, item]) || []);
  const moduleById = new Map(syllabus.map(module => [module.id, module]));

  let currentSection: LearningSection | undefined = section;
  let anchorLesson = section;
  let moduleId = '';
  let moduleTitle = '';
  const visited = new Set<string>();

  while (currentSection && !visited.has(currentSection.id)) {
    visited.add(currentSection.id);
    anchorLesson = currentSection;

    if (currentSection.parentId && moduleById.has(currentSection.parentId)) {
      moduleId = currentSection.parentId;
      moduleTitle = moduleById.get(currentSection.parentId)?.title || '';
      break;
    }

    currentSection = currentSection.parentId ? sectionById.get(currentSection.parentId) : undefined;
  }

  return {
    anchorLessonId: anchorLesson.id,
    anchorLessonContextPrompt: anchorLesson.contextPrompt,
    moduleId,
    moduleTitle,
  };
};

const buildLessonImageRefMap = (imageRefs?: LessonImageRef[]): Record<string, LessonImageRef> =>
  Object.fromEntries((imageRefs || []).map(imageRef => [imageRef.assetId, imageRef]));

const buildLessonAssetMap = (
  imageRefs: LessonImageRef[] | undefined,
  documentAssets: PdfDocumentAssets | null
): Record<string, PdfImageAsset> => {
  if (!documentAssets || !imageRefs?.length) {
    return {};
  }

  const assetIds = new Set(imageRefs.map(imageRef => imageRef.assetId));
  return Object.fromEntries(
    documentAssets.usedImages
      .filter(asset => assetIds.has(asset.id))
      .map(asset => [asset.id, asset])
  );
};

const mergeDocumentAssetsForPlan = (
  nextPlan: LearningPlan,
  currentAssets: PdfDocumentAssets | null,
  incomingAssets: PdfDocumentAssets | null
): PdfDocumentAssets | null => {
  const template = incomingAssets || currentAssets;
  if (!template) {
    return null;
  }

  const referencedAssetIds = new Set(
    nextPlan.sections.flatMap(section => (section.imageRefs || []).map(imageRef => imageRef.assetId))
  );
  const availableAssets = new Map<string, PdfImageAsset>();

  currentAssets?.usedImages.forEach(asset => {
    availableAssets.set(asset.id, asset);
  });
  incomingAssets?.usedImages.forEach(asset => {
    availableAssets.set(asset.id, asset);
  });

  return {
    kind: 'pdf',
    parsedAt: incomingAssets?.parsedAt || currentAssets?.parsedAt || template.parsedAt,
    imageCount: incomingAssets?.imageCount ?? currentAssets?.imageCount ?? template.imageCount,
    sourceHash: incomingAssets?.sourceHash || currentAssets?.sourceHash,
    usedImages: Array.from(referencedAssetIds)
      .map(assetId => availableAssets.get(assetId))
      .filter((asset): asset is PdfImageAsset => Boolean(asset)),
  };
};

const App = () => {
  // State
  const [state, setState] = useState<AppState>(AppState.LIBRARY);
  const [file, setFile] = useState<FileData | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<string>("Caricamento..."); // Detailed status
  const [isContextLoading, setIsContextLoading] = useState(false);
  
  // Assessment State
  const [assessmentMessages, setAssessmentMessages] = useState<Message[]>([]);
  const [currentAssessmentInput, setCurrentAssessmentInput] = useState('');
  const [chatSession, setChatSession] = useState<ChatSession | null>(null);

  // Planning State
  const [learningPlan, setLearningPlan] = useState<LearningPlan | null>(null);
  const [documentAssets, setDocumentAssets] = useState<PdfDocumentAssets | null>(null);
  const [documentIndex, setDocumentIndex] = useState<PdfTextIndex | null>(null);

  // Background Music State
  const [musicUrl, setMusicUrl] = useState<string>('');
  const [isMusicPlaying, setIsMusicPlaying] = useState(false);
  const [musicVolume, setMusicVolume] = useState(20); // Default low volume for background

  // Reading State
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [sectionContent, setSectionContent] = useState<string>('');
  const [speechBlocks, setSpeechBlocks] = useState<string[]>([]);
  const [quiz, setQuiz] = useState<QuizQuestion[]>([]);
  const [quizAnswers, setQuizAnswers] = useState<number[]>([]);
  const [isQuizSubmitted, setIsQuizSubmitted] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(createClosedContextMenuState);
  const [contextAnswer, setContextAnswer] = useState<ContextAnswerState | null>(null);
  const [contextAnswerSize, setContextAnswerSize] = useState<ContextAnswerSize>({
    width: CONTEXT_ANSWER_DEFAULT_WIDTH,
    height: CONTEXT_ANSWER_DEFAULT_HEIGHT,
  });

  // Focus & Accessibility State
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [teleprompterSpeed, setTeleprompterSpeed] = useState(1); // 1 is now slow, based on user feedback
  const [isLearnMode, setIsLearnMode] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [syllabus, setSyllabus] = useState<SyllabusItem[]>([]);
  const [expandedModuleId, setExpandedModuleId] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_LAYOUT_BREAKPOINT_PX
  );
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [backendUrl, setBackendUrl] = useState(() => getBackendUrl());
  const [locationProjectId, setLocationProjectId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : getProjectIdFromLocation(window.location)
  );
  
  // UI Visibilty States
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);

  const headerHoverBoundaryRef = useRef(64);
  const isHeaderHoveredRef = useRef(false);
  const fileUploadModeRef = useRef<'new-project' | 'reattach-source'>('new-project');
  const hasPendingExternalLocationRef = useRef(Boolean(locationProjectId));
  const nextLocationHistoryModeRef = useRef<'push' | 'replace'>('replace');
  const openProjectRequestRef = useRef(0);
  const openProjectHandlerRef = useRef<((projectId: string, options?: { source?: 'library' | 'route' }) => Promise<void>) | null>(null);

  // Refs
  const contentRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const selectionMenuTimeoutRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const assessmentInputRef = useRef<HTMLInputElement>(null);
  const previousActiveSectionIdRef = useRef<string | null>(null);
  const contextAnswerResizeRef = useRef<ContextAnswerResizeState | null>(null);
  const sourceFileInputId = useId();
  const planFileInputId = useId();
  const assessmentInputId = useId();

  const {
    audioState,
    calibrationOffset,
    handleToggleAudioSyncLink,
    handleToggleRuler,
    isAudioSyncLinked,
    isAutoTrackEnabled,
    isRulerActive,
    playerCurrentTime,
    playerDuration,
    setCalibrationFromRelativeY,
    setTestVoice,
    visualProgress,
    ttsConnected,
    togglePlayPause,
    stopAudio,
    handleSeek,
    handleSkipChunk,
    handleVoiceChange,
    handleSpeedChange,
  } = useTtsPlayer({
    activeSectionId,
    backendUrl,
    sectionContent,
    speechBlocks,
  });

  const {
    applySnapshotToWorkspace,
    currentProjectId,
    deleteStoredProject,
    downloadProject,
    importProjectData,
    isLibraryLoading,
    loadStoredProject,
    needsSourceFile,
    persistSnapshot,
    refreshSavedProjects,
    resetWorkspace,
    saveCurrentProject,
    savedProjects,
    setCurrentProjectId,
    setNeedsSourceFile,
    setProjectHydrated,
    storageError,
    touchStoredProject,
  } = useProjectLibrary<ChatSession, ContextAnswerState>({
    audioHandlers: {
      applyPlaybackRate: handleSpeedChange,
      applyPreferredVoice: handleVoiceChange,
      setTestVoice,
    },
    workspace: {
      activeSectionId,
      documentAssets,
      documentIndex,
      file,
      isDarkMode,
      isLearnMode,
      learningPlan,
      musicUrl,
      playbackRate: audioState.playbackRate,
      preferredVoice: audioState.currentVoice,
      state,
      syllabus,
      teleprompterSpeed,
      userProfile,
    },
    setters: {
      setActiveSectionId,
      setAssessmentMessages,
      setChatSession,
      setContextAnswer,
      setContextMenu,
      setCurrentAssessmentInput,
      setDocumentAssets,
      setDocumentIndex,
      setFile,
      setIsDarkMode,
      setIsFocusMode,
      setIsLearnMode,
      setIsLoading,
      setIsQuizSubmitted,
      setLearningPlan,
      setMusicUrl,
      setQuiz,
      setQuizAnswers,
      setSectionContent,
      setSpeechBlocks,
      setState,
      setSyllabus,
      setTeleprompterSpeed,
      setUserProfile,
    },
  });

  const preparePdfLessonPlan = useCallback(async (
    sourceFile: FileData | null,
    plan: LearningPlan,
    existingIndex?: PdfTextIndex | null,
    sectionIds?: string[]
  ): Promise<{ learningPlan: LearningPlan; documentIndex: PdfTextIndex | null }> => {
    if (!sourceFile) {
      return { learningPlan: plan, documentIndex: existingIndex ?? null };
    }

    setLoadingStatus(sectionIds?.length ? 'Associazione chunk alla nuova lezione...' : 'Indicizzazione capitoli del PDF...');
    return GeminiService.preparePdfLessonMappings(sourceFile, plan, existingIndex, sectionIds);
  }, []);

  const sidebarGroups = buildSidebarGroups(learningPlan, syllabus);
  const activeSection = learningPlan?.sections.find(section => section.id === activeSectionId) || null;
  const activeSidebarGroup = sidebarGroups.find((group) =>
    group.sections.some((section) => section.id === activeSectionId)
  ) || null;
  const activeSectionAssetsById = useMemo(
    () => buildLessonAssetMap(activeSection?.imageRefs, documentAssets),
    [activeSection?.imageRefs, documentAssets]
  );
  const activeSectionImageRefsById = useMemo(
    () => buildLessonImageRefMap(activeSection?.imageRefs),
    [activeSection?.imageRefs]
  );
  const shouldUseDesktopSidebar = !isMobileViewport && !isFocusMode;
  const shouldShowSidebar = isMobileViewport ? isMobileSidebarOpen : !isFocusMode;
  const audioDockOffset = shouldUseDesktopSidebar ? SIDEBAR_WIDTH_PX : 0;
  const clampContextAnswerSize = useCallback((width: number, height: number): ContextAnswerSize => {
    const maxWidth = typeof window === 'undefined'
      ? CONTEXT_ANSWER_DEFAULT_WIDTH
      : Math.max(CONTEXT_ANSWER_MIN_WIDTH, window.innerWidth - CONTEXT_ANSWER_VIEWPORT_MARGIN);
    const maxHeight = typeof window === 'undefined'
      ? CONTEXT_ANSWER_DEFAULT_HEIGHT
      : Math.max(CONTEXT_ANSWER_MIN_HEIGHT, window.innerHeight - CONTEXT_ANSWER_VIEWPORT_MARGIN);

    return {
      width: Math.min(Math.max(width, CONTEXT_ANSWER_MIN_WIDTH), maxWidth),
      height: Math.min(Math.max(height, CONTEXT_ANSWER_MIN_HEIGHT), maxHeight),
    };
  }, []);
  const handleModuleToggle = useCallback((groupId: string) => {
    flushSync(() => {
      setExpandedModuleId((currentId) => (currentId === groupId ? null : groupId));
    });
  }, []);
  const syncProjectLocation = useCallback((projectId: string | null, historyMode: 'push' | 'replace' = 'replace') => {
    if (typeof window === 'undefined') {
      return;
    }

    const nextHref = buildProjectLocationHref(window.location, projectId);
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (nextHref !== currentHref) {
      window.history[historyMode === 'push' ? 'pushState' : 'replaceState']({}, '', nextHref);
    }

    hasPendingExternalLocationRef.current = false;
    setLocationProjectId(projectId);
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((currentMenu) => {
      if (!currentMenu.visible) {
        return currentMenu;
      }

      return createClosedContextMenuState();
    });
  }, []);

  const openContextMenuFromSelection = useCallback((selection: Selection, placement: ContextMenuPlacement, fallbackAnchorX?: number, fallbackAnchorY?: number) => {
    if (!contentRef.current) {
      return false;
    }

    const nextMenu = resolveContextMenuSelection({
      container: contentRef.current,
      fallbackAnchorX,
      fallbackAnchorY,
      placement,
      selection,
    });

    if (!nextMenu) {
      return false;
    }

    setContextMenu((currentMenu) => {
      if (
        currentMenu.visible &&
        currentMenu.placement === nextMenu.placement &&
        currentMenu.selectedText === nextMenu.selectedText &&
        currentMenu.contextBefore === nextMenu.contextBefore &&
        currentMenu.contextAfter === nextMenu.contextAfter
      ) {
        return currentMenu;
      }

      return nextMenu;
    });

    return true;
  }, []);

  const scheduleMobileContextMenuSync = useCallback(() => {
    if (!isMobileViewport) {
      return;
    }

    if (selectionMenuTimeoutRef.current) {
      window.clearTimeout(selectionMenuTimeoutRef.current);
    }

    selectionMenuTimeoutRef.current = window.setTimeout(() => {
      selectionMenuTimeoutRef.current = null;

      const selection = window.getSelection();
      const syncAction = resolveMobileContextMenuSyncAction({
        hasSelection: Boolean(selection?.toString().trim() && selection.rangeCount > 0),
        isMenuFocused: Boolean(contextMenuRef.current?.contains(document.activeElement)),
        isMenuVisible: contextMenu.visible,
      });

      if (selection && syncAction === 'open-from-selection' && openContextMenuFromSelection(selection, 'mobile-sheet')) {
        return;
      }

      if (syncAction === 'keep-existing-menu') {
        return;
      }

      closeContextMenu();
    }, CONTEXT_MENU_MOBILE_DEBOUNCE_MS);
  }, [closeContextMenu, contextMenu.visible, isMobileViewport, openContextMenuFromSelection]);
  // --- Effects ---
  
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    const handleResize = () => {
      setIsMobileViewport(window.innerWidth < MOBILE_LAYOUT_BREAKPOINT_PX);
      setBackendUrl(getBackendUrl());
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      hasPendingExternalLocationRef.current = true;
      setLocationProjectId(getProjectIdFromLocation(window.location));
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!isMobileViewport) {
      setIsMobileSidebarOpen(false);
    }
  }, [isMobileViewport]);

  useEffect(() => {
    if (isMobileViewport && activeSectionId) {
      setIsMobileSidebarOpen(false);
    }
  }, [activeSectionId, isMobileViewport]);

  useEffect(() => {
    const shouldFocusAssessment = state === AppState.ASSESSMENT && assessmentMessages.length >= 0;

    if (shouldFocusAssessment) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      assessmentInputRef.current?.focus();
    }
  }, [assessmentMessages, state]);

  useEffect(() => {
    const handleResize = () => {
      setContextAnswerSize((currentSize) => clampContextAnswerSize(currentSize.width, currentSize.height));
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [clampContextAnswerSize]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const nextIsHovered = event.clientY <= headerHoverBoundaryRef.current;
      if (nextIsHovered === isHeaderHoveredRef.current) {
        return;
      }

      isHeaderHoveredRef.current = nextIsHovered;
      setIsHeaderHovered(nextIsHovered);
    };

    document.addEventListener('pointermove', handlePointerMove);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resizeState = contextAnswerResizeRef.current;
      if (!resizeState) {
        return;
      }

      const nextWidth = resizeState.startWidth + (resizeState.startX - event.clientX);
      const nextHeight = resizeState.startHeight + (resizeState.startY - event.clientY);
      setContextAnswerSize(clampContextAnswerSize(nextWidth, nextHeight));
    };

    const handlePointerUp = () => {
      if (!contextAnswerResizeRef.current) {
        return;
      }

      contextAnswerResizeRef.current = null;
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('cursor');
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [clampContextAnswerSize]);

  useEffect(() => {
    if (!contextMenu.visible) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (contextMenuRef.current?.contains(target)) {
        return;
      }

      if (isMobileViewport) {
        return;
      }

      closeContextMenu();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [closeContextMenu, contextMenu.visible, isMobileViewport]);

  useEffect(() => {
    if (!isMobileViewport) {
      if (selectionMenuTimeoutRef.current) {
        window.clearTimeout(selectionMenuTimeoutRef.current);
        selectionMenuTimeoutRef.current = null;
      }
      return;
    }

    const handleSelectionEvent = () => {
      scheduleMobileContextMenuSync();
    };

    document.addEventListener('selectionchange', handleSelectionEvent);
    window.addEventListener('pointerup', handleSelectionEvent);
    window.addEventListener('touchend', handleSelectionEvent);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionEvent);
      window.removeEventListener('pointerup', handleSelectionEvent);
      window.removeEventListener('touchend', handleSelectionEvent);

      if (selectionMenuTimeoutRef.current) {
        window.clearTimeout(selectionMenuTimeoutRef.current);
        selectionMenuTimeoutRef.current = null;
      }
    };
  }, [isMobileViewport, scheduleMobileContextMenuSync]);

  useEffect(() => {
    if (activeSectionId === null || activeSectionId.length > 0) {
      closeContextMenu();
    }
  }, [activeSectionId, closeContextMenu]);

  useEffect(() => {
    if (sidebarGroups.length === 0) {
      if (expandedModuleId !== null) {
        setExpandedModuleId(null);
      }
      previousActiveSectionIdRef.current = null;
      return;
    }

    const currentGroupStillExists = expandedModuleId
      ? sidebarGroups.some((group) => group.id === expandedModuleId)
      : false;

    if (!currentGroupStillExists) {
      const nextGroup = sidebarGroups.find((group) => group.sections.some((section) => !section.isCompleted)) || sidebarGroups[0];
      setExpandedModuleId(nextGroup.id);
      previousActiveSectionIdRef.current = activeSectionId;
      return;
    }

    if (!activeSectionId || previousActiveSectionIdRef.current === activeSectionId) {
      return;
    }

    previousActiveSectionIdRef.current = activeSectionId;

    const activeGroup = sidebarGroups.find((group) => group.sections.some((section) => section.id === activeSectionId));
    if (activeGroup && activeGroup.id !== expandedModuleId) {
      setExpandedModuleId(activeGroup.id);
    }
  }, [activeSectionId, expandedModuleId, sidebarGroups]);

  // Update Music URL in Plan when it changes
  useEffect(() => {
    if (learningPlan && musicUrl !== learningPlan.backgroundMusicUrl) {
        setLearningPlan({
            ...learningPlan,
            backgroundMusicUrl: musicUrl
        });
    }
  }, [learningPlan, musicUrl]);

  useEffect(() => {
    if (!sectionContent) {
      setSpeechBlocks([]);
      return;
    }

    const updateSpeechBlocks = () => {
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
    };

    const frameId = window.requestAnimationFrame(updateSpeechBlocks);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [sectionContent]);

  // --- Calibration: Double Click ---

  useEffect(() => {
    if (!isAutoTrackEnabled) {
      return;
    }

    const handleDocumentDoubleClick = (event: globalThis.MouseEvent) => {
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
      const targetProgress =
        block.startAudio + (block.endAudio - block.startAudio) * localProgress;

      setCalibrationFromRelativeY(targetProgress);
    };

    document.addEventListener('dblclick', handleDocumentDoubleClick);
    return () => {
      document.removeEventListener('dblclick', handleDocumentDoubleClick);
    };
  }, [isAutoTrackEnabled, setCalibrationFromRelativeY]);

  // Helper to extract text from a zip file
  const processZipFile = async (file: File): Promise<FileData> => {
    const zip = new JSZip();
    try {
      const contents = await zip.loadAsync(file);
      let combinedText = `PROJECT: ${file.name}\n\n`;
      let fileCount = 0;

      // Use an array to store promises so we can wait for all text reads
      const promises: Promise<void>[] = [];

      contents.forEach((relativePath, zipEntry) => {
         // 1. Skip directories
         if (zipEntry.dir) return;

         // 2. Skip ignored directories
         const parts = relativePath.split('/');
         if (parts.some(p => IGNORED_DIRS.includes(p) || p.startsWith('.'))) return;

         // 3. CONTENT-BASED FILTERING
         // Instead of relying on extensions, we check the actual file content.
         promises.push((async () => {
             // Read as raw bytes first to inspect
             const rawData = await zipEntry.async("uint8array");
             
             // Check if it's binary
             if (isBinaryFile(rawData)) {
                 // Skip binary files (images, executables, compiled objects)
                 return;
             }

             // Decode text
             try {
                const text = new TextDecoder("utf-8").decode(rawData);
                
                // Optional: Filter out empty files or huge files to prevent context overflow
                if (text.trim().length === 0) return;
                
                // Add to project context
                combinedText += `\n\n--- START OF FILE: ${relativePath} ---\n\n${text}`;
                fileCount++;
             } catch (_e) {
                // If decoding fails, it's likely a weird encoding or binary we missed
                console.warn(`Skipping ${relativePath} due to decoding error`);
             }
         })());
      });

      // Execute all reads
      await Promise.all(promises);

      if (fileCount === 0) {
        throw new Error("No readable text files found in this archive.");
      }
      
      combinedText = `This document contains the source code of a project. Analyze it as a whole codebase.\n\n${combinedText}`;

      // Convert combined text to Base64 for the Gemini Service
      // We use btoa with unescape/encodeURIComponent to handle Unicode correctly in browser environment
      const base64Content = btoa(unescape(encodeURIComponent(combinedText)));

      return {
        name: file.name,
        mimeType: 'text/plain', // We lie to Gemini and say it's plain text, because we concatenated it
        data: base64Content
      };
      
    } catch (e) {
      console.error('ZIP Error', e);
      throw new Error(`Failed to process ZIP file: ${getErrorMessage(e)}`);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) {
      return;
    }

    setIsLoading(true);
    setLoadingStatus("Caricamento...");

    try {
      let newFile: FileData;

      if (selectedFile.name.endsWith('.zip')) {
        newFile = await processZipFile(selectedFile);
      } else {
        const reader = new FileReader();
        newFile = await new Promise<FileData>((resolve) => {
          reader.onload = (event) => {
            const base64Data = (event.target?.result as string).split(',')[1];
            resolve({
              name: selectedFile.name,
              mimeType: selectedFile.type,
              data: base64Data,
            });
          };
          reader.readAsDataURL(selectedFile);
        });
      }

      if (fileUploadModeRef.current === 'reattach-source' && currentProjectId) {
        setFile(newFile);
        setNeedsSourceFile(false);
        setProjectHydrated(true);
        await saveCurrentProject({ file: newFile, state: learningPlan ? AppState.READING : state });
      } else {
        const nextProjectId = createProjectId();
        resetWorkspace();
        setCurrentProjectId(nextProjectId);
        setFile(newFile);
        setNeedsSourceFile(false);
        setProjectHydrated(true);

        await persistSnapshot(createProjectSnapshot({
          id: nextProjectId,
          state: AppState.ASSESSMENT,
          file: newFile,
        }));

        await startAssessment(newFile);
      }
    } catch (err) {
      alert(`Errore nel caricamento del file: ${getErrorMessage(err)}`);
    } finally {
      if (e.target) {
        e.target.value = '';
      }
      fileUploadModeRef.current = 'new-project';
      setIsLoading(false);
    }
  };

  const handlePlanUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) {
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        const { snapshot } = await importProjectData(json);
        applySnapshotToWorkspace(snapshot);
        void touchStoredProject(snapshot.id)
          .then(() => refreshSavedProjects())
          .catch((error) => {
            console.warn('Unable to refresh imported project metadata.', error);
          });
      } catch (_err) {
        alert("Il file JSON non è valido.");
      } finally {
        if (e.target) {
          e.target.value = '';
        }
      }
    };
    reader.readAsText(selectedFile);
  };

  const handleOpenProject = async (projectId: string, options?: { source?: 'library' | 'route' }) => {
    const requestId = openProjectRequestRef.current + 1;
    openProjectRequestRef.current = requestId;

    setOpeningProjectId(projectId);
    setLoadingStatus('Apertura progetto...');

    if (options?.source === 'library') {
      nextLocationHistoryModeRef.current = 'push';
    }

    try {
      const snapshot = await loadStoredProject(projectId);
      if (openProjectRequestRef.current !== requestId) {
        return;
      }

      if (!snapshot) {
        if (options?.source === 'route') {
          syncProjectLocation(null, 'replace');
        }
        return;
      }

      let nextSnapshot = snapshot;
      const pdfHydrationState = GeminiService.getPdfLessonMappingState(
        snapshot.file,
        snapshot.learningPlan,
        snapshot.documentIndex
      );

      if (pdfHydrationState === 'missing-document-index' || pdfHydrationState === 'missing-primary-chunk-mappings') {
        setIsLoading(true);
        setLoadingStatus(
          pdfHydrationState === 'missing-document-index'
            ? 'Indicizzazione capitoli del PDF...'
            : 'Allineamento lezioni con il PDF...'
        );
        const prepared = await preparePdfLessonPlan(snapshot.file, snapshot.learningPlan, snapshot.documentIndex);
        if (openProjectRequestRef.current !== requestId) {
          return;
        }

        nextSnapshot = createProjectSnapshot({
          ...snapshot,
          learningPlan: prepared.learningPlan,
          documentIndex: prepared.documentIndex,
        });
        await persistSnapshot(nextSnapshot);
        if (openProjectRequestRef.current !== requestId) {
          return;
        }
      }

      setIsMobileSidebarOpen(false);
      applySnapshotToWorkspace(nextSnapshot);
      void touchStoredProject(projectId)
        .then(() => refreshSavedProjects())
        .catch((error) => {
          console.warn('Unable to refresh project last-opened timestamp.', error);
        });

      if (!nextSnapshot.learningPlan && nextSnapshot.file) {
        await startAssessment(nextSnapshot.file);
        return;
      }

      if (nextSnapshot.learningPlan) {
        const nextSection =
          nextSnapshot.learningPlan.sections.find(section => section.id === nextSnapshot.activeSectionId) ||
          nextSnapshot.learningPlan.sections.find(section => !section.isCompleted) ||
          nextSnapshot.learningPlan.sections[0];

        if (nextSection && (!nextSection.content || nextSection.content.length === 0)) {
          await loadSection(nextSection, nextSnapshot.learningPlan, nextSnapshot.documentIndex ?? null, {
            context: {
              documentAssets: nextSnapshot.documentAssets ?? null,
              file: nextSnapshot.file,
              isLearnMode: nextSnapshot.isLearnMode,
              syllabus: nextSnapshot.syllabus,
              userProfile: nextSnapshot.userProfile,
            },
          });
        }
      }
    } finally {
      if (openProjectRequestRef.current === requestId) {
        setIsLoading(false);
        setOpeningProjectId(null);
      }
    }
  };

  const handleExportPlan = useCallback(async (projectId?: string) => {
    await downloadProject(projectId);
  }, [downloadProject]);
  openProjectHandlerRef.current = handleOpenProject;

  const handleDeleteProject = useCallback(async (projectId: string) => {
    const targetProject = savedProjects.find(project => project.id === projectId);
    const shouldDelete = window.confirm(`Eliminare "${targetProject?.title || 'questo progetto'}" dalla libreria locale?`);
    if (!shouldDelete) {
      return;
    }

    await deleteStoredProject(projectId);
    if (currentProjectId === projectId) {
      stopAudio(true);
      resetWorkspace();
      setState(AppState.LIBRARY);
    }
    await refreshSavedProjects();
  }, [currentProjectId, deleteStoredProject, refreshSavedProjects, resetWorkspace, savedProjects, stopAudio]);

  const handleBackToLibrary = useCallback(() => {
    nextLocationHistoryModeRef.current = 'replace';
    stopAudio(true);
    setIsFocusMode(false);
    setIsMobileSidebarOpen(false);
    setState(AppState.LIBRARY);
  }, [stopAudio]);

  const handleAttachSourceFile = useCallback(() => {
    fileUploadModeRef.current = 'reattach-source';
    const sourceInput = document.getElementById(sourceFileInputId) as HTMLInputElement | null;
    sourceInput?.click();
  }, [sourceFileInputId]);

  const handleUploadSourceClick = useCallback(() => {
    fileUploadModeRef.current = 'new-project';
    const sourceInput = document.getElementById(sourceFileInputId) as HTMLInputElement | null;
    sourceInput?.click();
  }, [sourceFileInputId]);

  const handleImportJsonClick = useCallback(() => {
    const planInput = document.getElementById(planFileInputId) as HTMLInputElement | null;
    planInput?.click();
  }, [planFileInputId]);

  const handleStartLearnJourney = async () => {
    const nextProjectId = createProjectId();
    resetWorkspace();
    setCurrentProjectId(nextProjectId);
    setIsLearnMode(true);
    setProjectHydrated(true);
    await persistSnapshot(createProjectSnapshot({
      id: nextProjectId,
      state: AppState.ASSESSMENT,
      isLearnMode: true,
    }));
    await startLearnAssessment();
  };

  const startAssessment = async (currentFile: FileData) => {
    setState(AppState.ASSESSMENT);
    setIsLoading(true);
    setLoadingStatus("Avvio Valutazione...");
    try {
      const session = await GeminiService.createAssessmentChat(currentFile, (status) => setLoadingStatus(status));
      setChatSession(session);
      setLoadingStatus("Avvio domande valutazione...");
      const result = await session.sendMessage({ message: "Analizza il contesto (anche se è un documento lungo) e inizia la valutazione." });
      setAssessmentMessages([{ role: 'model', text: result.text || '' }]);
    } catch (err) {
      console.error(err);
      alert("Errore nell'inizializzare la chat con Gemini. Controlla la console.");
      setState(AppState.LIBRARY);
    } finally {
      setIsLoading(false);
    }
  };

  const startLearnAssessment = async () => {
    setState(AppState.ASSESSMENT);
    setIsLoading(true);
    setLoadingStatus("Avvio Profilazione...");
    try {
      const session = GeminiService.createLearnAssessmentChat("Italiano");
      setChatSession(session);
      // We don't include the trigger message in the visible history to keep the turn counter at 1
      setAssessmentMessages([
        { role: 'model', text: "Ciao! Sono il tuo Architect. Cosa vuoi imparare esattamente oggi, e qual è il tuo obiettivo finale?" }
      ]);
    } catch (err) {
      console.error(err);
      alert("Errore nell'inizializzare la chat con Gemini. Controlla la console.");
      setState(AppState.LIBRARY);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAssessmentSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentAssessmentInput.trim() || !chatSession) return;

    const userMsg: Message = { role: 'user', text: currentAssessmentInput };
    setAssessmentMessages(prev => [...prev, userMsg]);
    setCurrentAssessmentInput('');
    setIsLoading(true);
    setLoadingStatus("Valutazione risposta...");

    try {
      if (isLearnMode) {
        const response = await chatSession.sendMessage({ message: userMsg.text });
        
        const call = response.functionCalls?.[0];
        if (call && call.name === 'finalizeProfile') {
          const profileArgs = (call.args ?? {}) as Partial<UserProfile>;
          const profile = {
            ...profileArgs,
            language: 'Italiano',
          } as UserProfile;
          setUserProfile(profile);
          await saveCurrentProject({ userProfile: profile, isLearnMode: true, state: AppState.ASSESSMENT });
          
          setAssessmentMessages(prev => [...prev, { role: 'model', text: "Perfetto, ho capito le tue esigenze. Sto creando il tuo piano di studi personalizzato..." }]);
          
          setTimeout(async () => {
            setState(AppState.PLANNING);
            setLoadingStatus("Creazione Piano Studi...");
            await generateLearnPlan(profile);
          }, 1500);
        } else {
          setAssessmentMessages(prev => [...prev, { role: 'model', text: response.text || '' }]);
        }
      } else {
        const userTurns = assessmentMessages.filter(m => m.role === 'user').length + 1;
        
        const result = await chatSession.sendMessage({ message: userMsg.text });
        const modelText = result.text || '';
        
        setAssessmentMessages(prev => [...prev, { role: 'model', text: modelText }]);

        if (modelText.includes('[ASSESSMENT_COMPLETE]') || userTurns >= ASSESSMENT_MIN_TURNS) {
          setTimeout(async () => {
             setState(AppState.PLANNING);
             setLoadingStatus("Creazione Piano Studi...");
             await generatePlan([...assessmentMessages, userMsg, { role: 'model', text: modelText }]);
          }, 1500);
        } 
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const generateLearnPlan = async (profile: UserProfile) => {
    setIsLoading(true);
    try {
      const newSyllabus = await GeminiService.generateFullCurriculum(
        profile,
        (msg) => setLoadingStatus(msg),
        (items) => setSyllabus(items as SyllabusItem[]),
        () => setLoadingStatus("Revisione finale...")
      );
      
      // Convert SyllabusItem[] to LearningPlan format to reuse existing UI
      const plan: LearningPlan = {
        title: profile.topic,
        summary: profile.context,
        sections: newSyllabus.flatMap(mod => 
          (mod.children || []).map(lesson => ({
            id: lesson.id,
            title: lesson.title,
            description: lesson.description,
            isCompleted: false,
            type: 'core' as const,
            parentId: mod.id,
            // Store contextPrompt in a custom field or just append to description for now
            // We'll need it when generating content
            contextPrompt: lesson.contextPrompt
          }))
        )
      };
      
      setLearningPlan(plan);
      setDocumentAssets(null);
      setDocumentIndex(null);
      setState(AppState.READING);
      setNeedsSourceFile(false);
      
      if (plan.sections.length > 0) {
        const firstSection = plan.sections[0];
        const projectId = currentProjectId || createProjectId();
        if (!currentProjectId) {
          setCurrentProjectId(projectId);
          setProjectHydrated(true);
        }
        setActiveSectionId(firstSection.id);
        await persistSnapshot(createProjectSnapshot({
          id: projectId,
          state: AppState.READING,
          file,
          learningPlan: plan,
          documentAssets: null,
          documentIndex: null,
          isLearnMode: true,
          userProfile: profile,
          syllabus: newSyllabus,
          activeSectionId: firstSection.id,
          musicUrl,
        }));
        void loadSection(firstSection, plan, null, {
          context: {
            documentAssets: null,
            file,
            isLearnMode: true,
            syllabus: newSyllabus,
            userProfile: profile,
          },
        });
      }
    } catch (err) {
      console.error("Plan generation error", err);
      alert("Errore nella generazione del piano. Riprova.");
      setState(AppState.LIBRARY); 
    } finally {
      setIsLoading(false);
    }
  };

  const generatePlan = async (history: Message[]) => {
    if (!file) return;
    setIsLoading(true);
    try {
      const plan = await GeminiService.generateLearningPlan(file, history, (status) => setLoadingStatus(status));
      const prepared = await preparePdfLessonPlan(file, plan, documentIndex);
      setLearningPlan(prepared.learningPlan);
      setDocumentAssets(null);
      setDocumentIndex(prepared.documentIndex);
      setState(AppState.READING);
      setNeedsSourceFile(false);
      
      if (prepared.learningPlan.sections.length > 0) {
        const firstSection = prepared.learningPlan.sections[0];
        const projectId = currentProjectId || createProjectId();
        if (!currentProjectId) {
          setCurrentProjectId(projectId);
          setProjectHydrated(true);
        }
        setActiveSectionId(firstSection.id);
        await persistSnapshot(createProjectSnapshot({
          id: projectId,
          state: AppState.READING,
          file,
          learningPlan: prepared.learningPlan,
          documentAssets: null,
          documentIndex: prepared.documentIndex,
          isLearnMode,
          userProfile,
          syllabus,
          activeSectionId: firstSection.id,
          musicUrl,
        }));
        void loadSection(firstSection, prepared.learningPlan, prepared.documentIndex, {
          context: {
            documentAssets: null,
            file,
            isLearnMode,
            syllabus,
            userProfile,
          },
        });
      }
    } catch (err) {
      console.error("Plan generation error", err);
      alert("Errore nella generazione del piano. Riprova.");
      setState(AppState.LIBRARY); 
    } finally {
      setIsLoading(false);
    }
  };

  const loadSection = async (
    section: LearningSection,
    currentPlan: LearningPlan | null = learningPlan,
    currentDocumentIndex: PdfTextIndex | null = documentIndex,
    options: LoadSectionOptions = {}
  ) => {
    if (!currentPlan) return;
    const forceRegenerate = options.forceRegenerate === true;
    const resolvedContext = options.context;
    const resolvedFile = resolvedContext?.file !== undefined ? resolvedContext.file : file;
    const resolvedIsLearnMode = resolvedContext?.isLearnMode ?? isLearnMode;
    const resolvedSyllabus = resolvedContext?.syllabus ?? syllabus;
    const resolvedUserProfile = resolvedContext?.userProfile !== undefined ? resolvedContext.userProfile : userProfile;
    const resolvedDocumentAssets = resolvedContext?.documentAssets !== undefined ? resolvedContext.documentAssets : documentAssets;
    
    // 1. BLOCKING NAVIGATION if already loading another section (Fixes override issue)
    if (isLoading) return;

    // 2. Prevent reloading same section ONLY if it already has content
    if (!forceRegenerate && activeSectionId === section.id && section.content && section.content.length > 0) return;
    
    // 3. IMMEDIATE RESET of Audio to prevent caching issues
    stopAudio(true);

    setActiveSectionId(section.id);
    setContextAnswer(null);
    setIsQuizSubmitted(false);
    setNeedsSourceFile(false);
    
    if (!forceRegenerate && section.content && section.content.length > 0) {
      setSectionContent(section.content);
      const cachedQuiz = section.quiz || [];
      setQuiz(cachedQuiz);
      setQuizAnswers(new Array(cachedQuiz.length).fill(-1));
      void saveCurrentProject({ activeSectionId: section.id, state: AppState.READING });
      return;
    }

    if (!forceRegenerate) {
      setSectionContent('');
      setQuiz([]);
      setQuizAnswers([]);
    }
    void saveCurrentProject({ activeSectionId: section.id, state: AppState.READING });

    // If we reach here, we need to generate content.
    const lessonGenerationState = resolveLessonGenerationState({
      file: resolvedFile,
      isLearnMode: resolvedIsLearnMode,
      learningPlan: currentPlan,
      syllabus: resolvedSyllabus,
    });

    if (lessonGenerationState === 'blocked-missing-source') {
        setNeedsSourceFile(true);
        return;
    }

    setIsLoading(true);
    setLoadingStatus(forceRegenerate ? "Rigenerazione lezione..." : "Analisi contenuti...");

    const completedTitles = currentPlan.sections
      .filter(s => s.isCompleted)
      .map(s => s.title)
      .join(", ");

    try {
      if (lessonGenerationState === 'learn-mode') {
        if (!resolvedIsLearnMode) {
          setIsLearnMode(true);
        }

        const { anchorLessonContextPrompt, anchorLessonId, moduleId, moduleTitle } = resolveLearnSectionContext(
          section,
          currentPlan,
          resolvedSyllabus
        );

        const content = await GeminiService.generateLearnLessonContent(
          section.title,
          moduleTitle,
          moduleId,
          anchorLessonId,
          section.contextPrompt || anchorLessonContextPrompt,
          resolvedUserProfile,
          resolvedSyllabus,
          (status) => setLoadingStatus(status)
        );
        
        setSectionContent(content);
        setQuiz([]);
        setQuizAnswers([]);
        const updatedPlan = {
          ...currentPlan,
          sections: currentPlan.sections.map(s => 
            s.id === section.id ? { ...s, content: content, quiz: [], imageRefs: [] } : s
          )
        };
        const mergedDocumentAssets = mergeDocumentAssetsForPlan(updatedPlan, resolvedDocumentAssets, null);
        setLearningPlan(updatedPlan);
        setDocumentAssets(mergedDocumentAssets);
        await saveCurrentProject({
          learningPlan: updatedPlan,
          documentAssets: mergedDocumentAssets,
          activeSectionId: section.id,
          state: AppState.READING,
          isLearnMode: true,
        });

      } else {
        const sourceFile = resolvedFile;
        if (!sourceFile) {
          throw new Error('Missing source file for section generation');
        }

        const { content, quiz, imageRefs, documentAssets: nextDocumentAssets } = await GeminiService.generateSectionContent(
          sourceFile, 
          section.title, 
          section.description, 
          completedTitles,
          section.primaryChunkIds,
          currentDocumentIndex,
          (status) => setLoadingStatus(status)
        );
        
        setSectionContent(content);
        setQuiz(quiz);
        setQuizAnswers(new Array(quiz.length).fill(-1));
        const updatedPlan = {
          ...currentPlan,
          sections: currentPlan.sections.map(s => 
            s.id === section.id ? { ...s, content: content, quiz: quiz, imageRefs } : s
          )
        };
        const mergedDocumentAssets = mergeDocumentAssetsForPlan(updatedPlan, resolvedDocumentAssets, nextDocumentAssets);
        setLearningPlan(updatedPlan);
        setDocumentAssets(mergedDocumentAssets);
        await saveCurrentProject({
          learningPlan: updatedPlan,
          documentAssets: mergedDocumentAssets,
          activeSectionId: section.id,
          state: AppState.READING,
        });
      }

    } catch (err) {
      console.error(err);
      alert("Errore nella generazione della lezione.");
    } finally {
      setIsLoading(false);
    }
  };

  // ... Context Menu Handlers
  const handleContextMenu = useCallback((e: ReactMouseEvent) => {
    if (isMobileViewport) {
      return;
    }

    const selection = window.getSelection();
    if (!selection) {
      return;
    }

    const didOpen = openContextMenuFromSelection(
      selection,
      'desktop-floating',
      e.clientX,
      e.clientY
    );

    if (didOpen) {
      e.preventDefault();
    }
  }, [isMobileViewport, openContextMenuFromSelection]);

  const handleContextQuestion = async (question: string) => {
    const { selectedText } = contextMenu;
    const canAnswerFromLesson = Boolean(
      activeSection?.content || sectionContent || contextMenu.contextBefore || contextMenu.contextAfter
    );

    if (!file && !canAnswerFromLesson) {
      setNeedsSourceFile(true);
      alert("Questo progetto non ha una fonte collegata e la lezione corrente non contiene abbastanza contesto per rispondere.");
      return;
    }

    setIsContextLoading(true);
    try {
      const answer = await GeminiService.askContextualQuestion({
        file,
        selection: selectedText,
        question,
        lessonTitle: activeSection?.title,
        lessonDescription: activeSection?.description,
        lessonContent: activeSection?.content || sectionContent,
        contextBefore: contextMenu.contextBefore,
        contextAfter: contextMenu.contextAfter,
      });
      setContextAnswer({ q: question, a: answer });
      closeContextMenu();
    } catch (e) { console.error(e); } finally { setIsContextLoading(false); }
  };

  const handleCreateLesson = async (instructions: string) => {
    if (!learningPlan || !activeSectionId) {
      alert("La lezione attiva non e disponibile. Riprova dopo aver aperto una sezione del percorso.");
      return;
    }

    const { selectedText } = contextMenu;
    const parentSection = learningPlan.sections.find(s => s.id === activeSectionId);
    if (!parentSection) {
      alert("Non riesco a trovare la lezione corrente nel piano. Ricarica il progetto e riprova.");
      return;
    }

    setIsContextLoading(true);
    try {
      const canCreateWithoutFile = isLearnMode || syllabus.length > 0 || learningPlan.sections.some(section => Boolean(section.parentId));
      const newSection = file
        ? await GeminiService.createSubChapterMetadata(file, parentSection, selectedText, instructions)
        : canCreateWithoutFile
          ? await GeminiService.createLearnSubChapterMetadata(
              parentSection,
              selectedText,
              instructions,
              resolveLearnSectionContext(parentSection, learningPlan, syllabus).moduleTitle,
              userProfile
            )
          : null;

      if (!newSection) {
        setNeedsSourceFile(true);
        alert("Questo progetto non ha un file sorgente collegato. Ricollega il PDF o lo ZIP prima di creare una sottolezione.");
        return;
      }

      const parentIndex = learningPlan.sections.findIndex(s => s.id === activeSectionId);
      const newSections = [...learningPlan.sections];
      newSections.splice(parentIndex + 1, 0, newSection);
      let updatedPlan = { ...learningPlan, sections: newSections };
      let nextDocumentIndex = documentIndex;

      if (file) {
        const prepared = await preparePdfLessonPlan(file, updatedPlan, documentIndex, [newSection.id]);
        updatedPlan = prepared.learningPlan;
        nextDocumentIndex = prepared.documentIndex;
      }

      setLearningPlan(updatedPlan);
      setDocumentIndex(nextDocumentIndex);
      await saveCurrentProject({ learningPlan: updatedPlan, documentIndex: nextDocumentIndex, activeSectionId, state: AppState.READING });
      closeContextMenu();
      const mappedNewSection = updatedPlan.sections.find(section => section.id === newSection.id) || newSection;
      await loadSection(mappedNewSection, updatedPlan, nextDocumentIndex, {
        context: {
          documentAssets,
          file,
          isLearnMode,
          syllabus,
          userProfile,
        },
      });
    } catch (e) { console.error(e); alert("Impossibile creare la lezione."); } finally { setIsContextLoading(false); }
  };

  const handleRegenerateActiveSection = () => {
    if (!activeSection || !learningPlan) {
      return;
    }

    void loadSection(activeSection, learningPlan, documentIndex, { forceRegenerate: true });
  };

  const applyStyleToSelection = () => {
      if (!activeSectionId || !learningPlan) return;

      const currentSection = learningPlan.sections.find(section => section.id === activeSectionId);
      const sourceContent = currentSection?.content || sectionContent;
      const newContent = toggleHighlightInContent({
        content: sourceContent,
        selectedText: contextMenu.selectedText,
        contextBefore: contextMenu.contextBefore,
        contextAfter: contextMenu.contextAfter,
      });
      if (!newContent) {
        return;
      }

      const updatedPlan = {
        ...learningPlan,
        sections: learningPlan.sections.map(s =>
          s.id === activeSectionId ? { ...s, content: newContent } : s
        ),
      };

      setSectionContent(newContent);
      setLearningPlan(updatedPlan);
      window.getSelection()?.removeAllRanges();

      void saveCurrentProject({
        learningPlan: updatedPlan,
        activeSectionId,
        state: AppState.READING,
      });
  };
  
  const handleHighlight = () => {
    const { selectedText } = contextMenu;
    if (!selectedText) return;
    
    applyStyleToSelection();
    closeContextMenu();
  };

  const handleContextAnswerResizeStart = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    contextAnswerResizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: contextAnswerSize.width,
      startHeight: contextAnswerSize.height,
    };
    document.body.style.setProperty('user-select', 'none');
    document.body.style.setProperty('cursor', 'nesw-resize');
  }, [contextAnswerSize.height, contextAnswerSize.width]);

  const completeSection = async () => {
    if (!learningPlan || !activeSectionId) return;
    const newSections = learningPlan.sections.map(s => s.id === activeSectionId ? { ...s, isCompleted: true } : s);
    const updatedPlan = { ...learningPlan, sections: newSections };
    setLearningPlan(updatedPlan);
    await saveCurrentProject({ learningPlan: updatedPlan, activeSectionId, state: AppState.READING });
    const currentIndex = newSections.findIndex(s => s.id === activeSectionId);
    if (currentIndex < newSections.length - 1) loadSection(newSections[currentIndex + 1], updatedPlan);
    else alert("Percorso completato! Ricordati di esportare il tuo progresso.");
  };

  useEffect(() => {
    if (isLibraryLoading) {
      return;
    }

    if (!locationProjectId) {
      if (hasPendingExternalLocationRef.current && state !== AppState.LIBRARY) {
        handleBackToLibrary();
      }

      hasPendingExternalLocationRef.current = false;
      return;
    }

    if (openingProjectId === locationProjectId) {
      return;
    }

    if (locationProjectId === currentProjectId && state !== AppState.LIBRARY) {
      hasPendingExternalLocationRef.current = false;
      return;
    }

    void openProjectHandlerRef.current?.(locationProjectId, { source: 'route' });
  }, [
    currentProjectId,
    handleBackToLibrary,
    isLibraryLoading,
    locationProjectId,
    openingProjectId,
    state,
  ]);

  useEffect(() => {
    const expectedProjectId = state === AppState.LIBRARY ? null : currentProjectId;
    if (hasPendingExternalLocationRef.current && locationProjectId !== expectedProjectId) {
      return;
    }

    syncProjectLocation(expectedProjectId, nextLocationHistoryModeRef.current);
    nextLocationHistoryModeRef.current = 'replace';
  }, [currentProjectId, locationProjectId, state, syncProjectLocation]);

  if (state === AppState.LIBRARY) {
    return (
      <LibraryView
        isDarkMode={isDarkMode}
        isLibraryLoading={isLibraryLoading}
        isWorking={isLoading}
        loadingStatus={loadingStatus}
        openingProjectId={openingProjectId}
        planFileInputId={planFileInputId}
        projects={savedProjects}
        sourceFileInputId={sourceFileInputId}
        storageError={storageError}
        onDeleteProject={handleDeleteProject}
        onExportProject={(projectId) => {
          void handleExportPlan(projectId);
        }}
        onOpenProject={(projectId) => {
          void handleOpenProject(projectId, { source: 'library' });
        }}
        onPlanUpload={(event) => {
          void handlePlanUpload(event);
        }}
        onStartLearnJourney={() => {
          void handleStartLearnJourney();
        }}
        onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
        onUploadSourceClick={handleUploadSourceClick}
        onSourceFileUpload={(event) => {
          void handleFileUpload(event);
        }}
        onImportJsonClick={handleImportJsonClick}
      />
    );
  }
  if (state === AppState.ASSESSMENT) {
    return (
      <AssessmentView
        assessmentInputId={assessmentInputId}
        assessmentInputRef={assessmentInputRef}
        currentAssessmentInput={currentAssessmentInput}
        isDarkMode={isDarkMode}
        isLoading={isLoading}
        loadingStatus={loadingStatus}
        messages={assessmentMessages}
        messagesEndRef={messagesEndRef}
        onBackToLibrary={handleBackToLibrary}
        onInputChange={setCurrentAssessmentInput}
        onSubmit={handleAssessmentSubmit}
      />
    );
  }
  if (state === AppState.PLANNING) { return <LoadingScreen message="Analisi Volume in Corso..." subMessage={loadingStatus || "Costruzione piano..."} />; }

  return (
    <div className="flex h-screen max-w-full overflow-hidden bg-paper-light font-sans transition-colors duration-300 dark:bg-paper-dark">
      <input id={sourceFileInputId} type="file" className="hidden" accept=".pdf,.zip" onChange={handleFileUpload} />
      
      {/* IMPLICIT AUTOTRACK: If ruler is active, we pass it down */}
      {isRulerActive && (
        <ReadingRuler 
          isPlaying={audioState.isPlaying} 
          progress={visualProgress} 
          contentRef={contentRef}
          scrollContainerRef={scrollContainerRef}
          calibrationOffset={calibrationOffset}
          teleprompterSpeed={teleprompterSpeed}
          isHeaderHovered={isHeaderHovered}
        />
      )}

      {isMobileViewport && shouldShowSidebar ? (
        <button
          type="button"
          aria-label="Chiudi elenco lezioni"
          className="fixed inset-0 z-20 bg-black/40 backdrop-blur-[1px]"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      ) : null}
      
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex h-screen flex-col border-r border-gray-200/80 bg-white dark:border-zinc-800 dark:bg-zinc-900 transition-transform duration-300 ${
          shouldShowSidebar ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ width: isMobileViewport ? 'min(92vw, 24rem)' : SIDEBAR_WIDTH_PX }}
      >
        <div className="flex flex-col gap-4 border-b border-gray-200/80 px-5 py-5 dark:border-zinc-800 sm:px-6">
          <div className="flex justify-between items-start gap-4">
             <h1 className="font-serif font-bold text-xl text-gray-900 dark:text-white leading-tight">
              {learningPlan?.title || "Percorso di Studio"}
             </h1>
             {isMobileViewport ? (
               <button
                 type="button"
                 onClick={() => setIsMobileSidebarOpen(false)}
                 className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100/80 hover:text-gray-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
                 title="Chiudi elenco lezioni"
               >
                 <XIcon className="w-5 h-5" />
               </button>
             ) : (
               <button 
                  type="button"
                  onClick={() => setIsFocusMode(true)}
                  className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100/80 hover:text-gray-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
                  title="Nascondi Menu (Focus Mode)"
               >
                  <SidebarClose className="w-5 h-5" />
               </button>
             )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleBackToLibrary}
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-gray-100/80 dark:bg-zinc-800/90 hover:bg-gray-200/90 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors"
            >
              <LibraryBig className="w-4 h-4" /> Libreria
            </button>
            <button 
              type="button"
              onClick={() => {
                void handleExportPlan();
              }}
              disabled={isLoading}
              className={`flex items-center justify-center gap-2 w-full py-2.5 bg-gray-100/80 dark:bg-zinc-800/90 hover:bg-gray-200/90 dark:hover:bg-zinc-700 text-gray-700 dark:text-gray-300 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <Download className="w-4 h-4" /> Esporta
            </button>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="space-y-3">
            {sidebarGroups.map((group) => {
              const isExpanded = expandedModuleId === group.id;

              return (
                <section key={group.id} className="border-b border-gray-200/70 dark:border-zinc-800/90 pb-3 last:border-b-0 last:pb-0">
                  <button
                    type="button"
                    onClick={() => handleModuleToggle(group.id)}
                    className={`w-full px-3 py-2 flex items-center gap-3 rounded-lg text-left transition-colors ${
                      isExpanded
                        ? 'text-gray-900 dark:text-gray-100'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100/70 dark:hover:bg-zinc-800/70'
                    }`}
                  >
                    <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform duration-300 ${isExpanded ? 'rotate-90' : ''}`} />
                    <span className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.18em] truncate">
                      {group.title}
                    </span>
                  </button>

                  {isExpanded ? (
                    <div>
                      <div className="mt-2 ml-5 space-y-1 border-l border-gray-200 dark:border-zinc-800 pl-4">
                        {group.sections.map((section) => {
                          const isActive = activeSectionId === section.id;

                          return (
                            <button
                              type="button"
                              key={section.id}
                              onClick={() => {
                                if (isMobileViewport) {
                                  setIsMobileSidebarOpen(false);
                                }
                                void loadSection(section);
                              }}
                              disabled={isLoading}
                              className={`w-full text-left py-2 flex items-center gap-3 transition-colors ${
                                isActive
                                  ? 'text-gray-900 dark:text-gray-100'
                                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                              } ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              <div className={`w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center rounded-full border transition-colors ${
                                section.isCompleted
                                  ? 'border-gray-300 dark:border-zinc-600 bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-gray-400'
                                  : isActive
                                    ? 'border-gray-500 dark:border-zinc-400 bg-gray-500 dark:bg-zinc-400 text-transparent'
                                    : 'border-gray-300 dark:border-zinc-700 bg-transparent text-transparent'
                              }`}>
                                {section.isCompleted ? <CheckCircle2 className="w-3 h-3" /> : null}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className={`text-sm truncate ${isActive ? 'font-medium' : 'font-normal'}`}>
                                  {section.title}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>
      </aside>

      <div
        className="relative flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-x-hidden bg-paper-light transition-[margin] duration-300 dark:bg-paper-dark"
        style={{ marginLeft: shouldUseDesktopSidebar ? SIDEBAR_WIDTH_PX : 0 }}
      >
        {storageError ? (
          <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-red-200 bg-red-50/80 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300 sm:mx-8 sm:mt-5">
            <span>{storageError}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  void handleExportPlan();
                }}
                className="inline-flex items-center justify-center rounded-full border border-red-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700 transition-colors hover:bg-red-100 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/60"
              >
                Esporta
              </button>
              <button
                type="button"
                onClick={handleBackToLibrary}
                className="inline-flex items-center justify-center rounded-full border border-red-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700 transition-colors hover:bg-red-100 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/60"
              >
                Libreria
              </button>
            </div>
          </div>
        ) : null}
        {needsSourceFile ? (
          <div className="mx-4 mt-4 flex flex-col items-start justify-between gap-4 rounded-2xl border border-gray-200 bg-white/90 px-4 py-3 text-sm text-gray-600 dark:border-zinc-800 dark:bg-zinc-900/90 dark:text-zinc-300 sm:mx-8 sm:mt-5 sm:flex-row sm:items-center">
            <span>Questo progetto e stato importato senza file sorgente. Ricollega il PDF o lo ZIP per generare nuove lezioni.</span>
            <button
              type="button"
              onClick={handleAttachSourceFile}
              className="inline-flex items-center justify-center rounded-full bg-gray-900 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-black dark:bg-white dark:text-black dark:hover:bg-gray-200"
            >
              Ricollega sorgente
            </button>
          </div>
        ) : null}
        
        {/* HEADER 
            UPDATED: Opacity changes based on isRulerActive and Hover state.
            If Ruler Active: Opacity 0 (unless hovered).
            If Ruler Inactive: Opacity 100.
        */}
        <header 
            className={`
                border-b border-gray-100 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80 
                sticky top-0 relative z-50 flex flex-shrink-0 items-center justify-between overflow-hidden
                transition-opacity duration-500 ease-in-out
                ${isMobileViewport ? 'min-h-[4.5rem] px-4 py-3 gap-3' : 'h-16 px-8'}
                ${isRulerActive && !isHeaderHovered ? 'opacity-0 hover:opacity-100' : 'opacity-100'}
            `}
        >
           <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
              {isMobileViewport ? (
                <>
                  <button
                    type="button"
                    onClick={handleBackToLibrary}
                    className="rounded-full border border-gray-200 bg-white/85 p-2 text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-700 dark:bg-zinc-900/85 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-white"
                    title="Torna alla libreria"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsMobileSidebarOpen(true)}
                    className="rounded-full border border-gray-200 bg-white/85 p-2 text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-700 dark:bg-zinc-900/85 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-white"
                    title="Apri elenco lezioni"
                  >
                    <SidebarOpen className="h-4 w-4" />
                  </button>
                  <div className="min-w-0">
                    <p className="truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
                      {activeSidebarGroup?.title || learningPlan?.title || 'Percorso'}
                    </p>
                    <h2 className="truncate font-serif text-base text-gray-900 dark:text-white">
                      {activeSection?.title || learningPlan?.title || 'Lezione'}
                    </h2>
                  </div>
                </>
              ) : (
                isFocusMode && (
                <button 
                  type="button"
                  onClick={() => setIsFocusMode(false)}
                  className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all"
                  title="Mostra Menu"
                >
                  <SidebarOpen className="w-5 h-5" />
                </button>
                )
              )}
           </div>
           
           <div className={`flex shrink-0 items-center ${isMobileViewport ? 'gap-3' : 'gap-6'}`}>
             {isLoading && (
               <div className={`flex items-center gap-2 rounded-full bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400 animate-pulse ${isMobileViewport ? 'px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]' : 'px-4 py-1.5 text-xs font-bold'}`}>
                 <span className="w-2 h-2 rounded-full bg-orange-500"></span>
                 {isMobileViewport ? 'Carica' : loadingStatus.toUpperCase()}
               </div>
             )}

             <button
               type="button"
               onClick={handleRegenerateActiveSection}
               disabled={!activeSection || isLoading}
               className={`inline-flex items-center justify-center rounded-full border transition-colors ${
                 isMobileViewport
                   ? 'h-10 w-10'
                   : 'gap-2 px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em]'
               } ${
                 !activeSection || isLoading
                   ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500'
                   : 'border-gray-200 bg-white/90 text-gray-700 hover:border-orange-300 hover:text-orange-700 dark:border-zinc-700 dark:bg-zinc-900/85 dark:text-zinc-200 dark:hover:border-orange-500/60 dark:hover:text-orange-300'
               }`}
               title={activeSection ? 'Rigenera la lezione corrente' : 'Apri una lezione per rigenerarla'}
             >
               <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
               {!isMobileViewport ? <span>Rigenera</span> : null}
             </button>
             
             {/* Reading Tools */}
             <div className={`flex items-center rounded-full border border-gray-200 bg-gray-100 p-1 shadow-sm transition-all dark:border-zinc-700 dark:bg-zinc-800 ${isMobileViewport ? 'max-w-[11rem]' : ''}`}>
               <button 
                type="button"
                onClick={handleToggleRuler}
                className={`p-1.5 rounded-full transition-colors ${isRulerActive ? 'bg-orange-600 shadow text-white' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
                title="Attiva righello di lettura (Autoscroll)"
               >
                 <Ruler className="w-4 h-4" />
               </button>
               
               {/* Teleprompter Controls (SLIDER REPLACEMENT) */}
               {isRulerActive && (
                  <div className={`mx-2 flex items-center gap-2 animate-in fade-in zoom-in-95 border-l border-gray-300 pl-2 dark:border-zinc-600 ${audioState.isPlaying ? 'cursor-not-allowed opacity-50 grayscale' : ''}`}>
                      <Gauge className="w-3 h-3 text-gray-400" />
                      <input 
                        type="range"
                        min="0.1"
                        max="3"
                        step="0.1"
                        value={teleprompterSpeed}
                        onChange={(e) => !audioState.isPlaying && setTeleprompterSpeed(parseFloat(e.target.value))}
                        disabled={audioState.isPlaying}
                        className={`h-1.5 appearance-none rounded-lg bg-gray-300 accent-orange-600 dark:bg-zinc-600 ${isMobileViewport ? 'w-14' : 'w-24'} ${audioState.isPlaying ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        title={audioState.isPlaying ? "Velocità controllata dall'audio" : "Velocità Autoscroll"}
                      />
                      <span className={`w-8 text-right font-mono text-gray-500 ${isMobileViewport ? 'text-[9px]' : 'text-[10px]'}`}>{teleprompterSpeed.toFixed(1)}x</span>
                  </div>
               )}
             </div>
             
             {/* Music Player Control */}
             {!isMobileViewport ? (
               <>
                 <MusicPlayer 
                    url={musicUrl}
                    setUrl={setMusicUrl}
                    isPlaying={isMusicPlaying}
                    setIsPlaying={setIsMusicPlaying}
                    volume={musicVolume}
                    setVolume={setMusicVolume}
                 />
                 <div className="mx-1 h-4 w-px bg-gray-300 dark:bg-zinc-600"></div>
               </>
             ) : null}

              <button 
              type="button"
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-2 rounded-full bg-transparent hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors border border-transparent hover:border-gray-200 dark:hover:border-zinc-700"
              title="Cambia Tema"
             >
               {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
             </button>
           </div>
        </header>

        <div
          ref={scrollContainerRef}
          className="relative flex-1 min-w-0 overflow-y-auto overflow-x-hidden scroll-smooth"
        >
          <div className={`mx-auto w-full min-w-0 max-w-full px-4 pb-36 pt-8 transition-all duration-500 sm:px-8 lg:px-12 ${isFocusMode ? 'max-w-3xl' : 'max-w-4xl'}`}>
            
            <section 
              ref={contentRef}
              className={`mb-16 min-h-[50vh] min-w-0 max-w-full ${isAutoTrackEnabled ? 'cursor-crosshair' : ''}`}
            >
              {isLoading ? (
                  <div className="space-y-8 animate-pulse mt-8 max-w-2xl mx-auto">
                    <div className="h-8 bg-gray-200 dark:bg-zinc-800 rounded w-3/4 mb-12"></div>
                    <div className="space-y-3">
                      <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-full"></div>
                      <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-full"></div>
                      <div className="h-4 bg-gray-200 dark:bg-zinc-800 rounded w-5/6"></div>
                    </div>
                  </div>
              ) : (
                 <>
                  {sectionContent && (
                    <MarkdownRenderer 
                      content={sectionContent} 
                      isDarkMode={isDarkMode}
                      lessonAssetsById={activeSectionAssetsById}
                      lessonImageRefsById={activeSectionImageRefsById}
                      className={`prose-lg sm:prose-xl leading-7 sm:leading-loose
                        prose-p:text-gray-800 dark:prose-p:text-gray-200 
                        prose-headings:text-gray-900 dark:prose-headings:text-white 
                        prose-headings:font-serif prose-headings:font-normal 
                        prose-strong:text-orange-800 dark:prose-strong:text-orange-400 
                        prose-strong:font-semibold
                        ${isDarkMode ? 'prose-invert' : ''}
                      `}
                      onContextMenu={handleContextMenu}
                    />
                  )}
                  {!sectionContent && (
                    <div className="mt-16 flex flex-col items-center text-center text-gray-400 sm:mt-20">
                       <BookOpen className="w-16 h-16 opacity-20 mb-4" />
                       <p>{isMobileViewport ? 'Apri il menu lezioni per scegliere cosa leggere.' : 'Seleziona una sezione dal piano di studi per iniziare.'}</p>
                    </div>
                  )}
                 </>
              )}
            </section>
            
            {/* Quiz Section (Keep existing) */}
            {quiz.length > 0 && sectionContent && (
                  <div className="mt-24 pt-12 border-t-2 border-dashed border-gray-200 dark:border-zinc-800">
                    <div className="flex items-center gap-3 mb-8">
                      <div className="p-2 bg-orange-100 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 rounded-lg">
                        <GraduationCap className="w-6 h-6" />
                      </div>
                      <h3 className="text-2xl font-serif text-gray-900 dark:text-gray-100">Verifica Comprensione</h3>
                    </div>
                    
                    <div className="grid gap-6">
                      {quiz.map((q, qIdx) => (
                        <div key={q.question} className="bg-white dark:bg-zinc-900 p-8 rounded-2xl shadow-sm border border-gray-100 dark:border-zinc-800 transition-all hover:shadow-md">
                          <p className="text-lg font-medium text-gray-800 dark:text-gray-200 mb-6 font-serif">{q.question}</p>
                          <div className="space-y-3">
                            {q.options.map((opt: string, oIdx: number) => (
                              <button
                                type="button"
                                key={`${q.question}-${opt}`}
                                onClick={() => {
                                  if (isQuizSubmitted) return;
                                  const newAnswers = [...quizAnswers];
                                  newAnswers[qIdx] = oIdx;
                                  setQuizAnswers(newAnswers);
                                }}
                                className={`w-full text-left p-4 rounded-xl text-base transition-all border-2 ${
                                  isQuizSubmitted
                                    ? oIdx === q.correctIndex
                                      ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300'
                                      : quizAnswers[qIdx] === oIdx
                                        ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
                                        : 'border-transparent opacity-50 bg-gray-50 dark:bg-zinc-800'
                                    : quizAnswers[qIdx] === oIdx
                                      ? 'bg-orange-50 dark:bg-orange-900/10 border-orange-300 dark:border-orange-700 text-orange-900 dark:text-orange-300 shadow-sm'
                                      : 'bg-white dark:bg-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-700 border-gray-100 dark:border-zinc-700 text-gray-600 dark:text-gray-400'
                                }`}
                              >
                                <span className="inline-block w-6 font-bold opacity-40 mr-2">{String.fromCharCode(65 + oIdx)}.</span>
                                {opt}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-12 flex justify-end pb-12">
                      {!isQuizSubmitted ? (
                        <button
                          type="button"
                          onClick={() => setIsQuizSubmitted(true)}
                          disabled={quizAnswers.includes(-1)}
                          className="bg-gray-900 dark:bg-white text-white dark:text-black px-8 py-4 rounded-xl font-medium hover:bg-black dark:hover:bg-gray-200 disabled:opacity-50 transition-colors shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                        >
                          Controlla Risposte
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={completeSection}
                          className="bg-orange-600 text-white px-10 py-4 rounded-xl font-medium hover:bg-orange-700 shadow-xl shadow-orange-200 dark:shadow-none flex items-center gap-3 transition-all hover:-translate-y-1"
                        >
                          Completa e Prosegui <ChevronRight className="w-5 h-5" />
                        </button>
                      )}
                    </div>
                  </div>
                )}
          </div>
        </div>
        
        {sectionContent && (
          <AudioPlayer
            isPlaying={audioState.isPlaying}
            // CRITICAL: Only show loading on player if CURRENT chunk is loading.
            // Future chunks loading in bg should not lock UI.
            isLoading={audioState.chunks[audioState.currentChunkIndex]?.isLoading || false}
            currentVoice={audioState.currentVoice}
            playbackRate={audioState.playbackRate}
            isVertical
            dockOffsetPx={audioDockOffset}
            currentTime={playerCurrentTime}
            duration={playerDuration}
            onPlayPause={togglePlayPause}
            onVoiceChange={handleVoiceChange}
            onSpeedChange={handleSpeedChange}
            onSeek={handleSeek}
            onSkipChunk={handleSkipChunk}
            isAudioSyncLinked={isAudioSyncLinked}
            onToggleAudioSyncLink={handleToggleAudioSyncLink}
            ttsConnected={ttsConnected}
          />
        )}
        
        {/* Context Menu and Answer overlays (Same) */}
        {contextAnswer && (
          <div 
            className={`fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-orange-100 bg-white p-6 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] animate-in slide-in-from-bottom-10 duration-500 dark:border-orange-900/30 dark:bg-zinc-900 ${
              isMobileViewport ? 'inset-x-3 bottom-24 top-24' : 'bottom-24 right-8'
            }`}
            style={isMobileViewport ? undefined : { width: contextAnswerSize.width, height: contextAnswerSize.height }}
          >
             <div className="mb-4 flex items-start justify-between gap-3">
               <div className="flex items-center gap-2 text-orange-600 dark:text-orange-400 text-xs font-bold uppercase tracking-wider bg-orange-50 dark:bg-orange-900/20 px-3 py-1 rounded-full">
                  <MessageSquare className="w-3 h-3" /> Risposta AI
               </div>
               <button type="button" onClick={() => setContextAnswer(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 bg-gray-50 dark:bg-zinc-800 p-1 rounded-full"><XIcon className="w-4 h-4" /></button>
              </div>
             <p className="mb-3 shrink-0 border-l-2 border-orange-500 pl-3 text-base font-serif font-bold text-gray-900 dark:text-gray-100">"{contextAnswer.q}"</p>
             <div className="custom-scrollbar min-h-0 flex-1 overflow-auto pr-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                <MarkdownRenderer content={contextAnswer.a} isDarkMode={isDarkMode} className="prose-sm prose-p:text-gray-600 dark:prose-p:text-gray-300" />
             </div>
             {!isMobileViewport ? (
               <button
                 type="button"
                 aria-label="Ridimensiona pannello risposta"
                 onMouseDown={handleContextAnswerResizeStart}
                 className="absolute bottom-3 left-3 flex h-5 w-5 cursor-nesw-resize items-end justify-start rounded-sm text-orange-300 transition-colors hover:text-orange-500 dark:text-orange-700 dark:hover:text-orange-400"
               >
                 <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
                   <title>Ridimensiona pannello risposta</title>
                   <path d="M1 15L15 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                   <path d="M1 11L11 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                   <path d="M1 7L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                 </svg>
               </button>
             ) : null}
          </div>
        )}

        {contextMenu.visible && (
          <ContextMenu 
            {...contextMenu} 
            containerRef={contextMenuRef}
            onClose={closeContextMenu}
            onAsk={handleContextQuestion}
            onCreateLesson={handleCreateLesson}
            onHighlight={handleHighlight}
            isLoading={isContextLoading} 
          />
        )}
      </div>
    </div>
  );
};

const XIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <title>Chiudi</title>
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
);

export default App;
