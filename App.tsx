import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { BookOpen, CheckCircle2, ChevronRight, BrainCircuit, GraduationCap, MessageSquare, Download, Ruler, Moon, Sun, SidebarOpen, SidebarClose, Gauge, LibraryBig } from 'lucide-react';
import JSZip from 'jszip';
import { AppState, type ContextMenuState, type FileData, type LearningPlan, type LearningSection, type Message, type QuizQuestion, type SyllabusItem, type UserProfile } from './types';
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
import { buildReadableBlocks } from './utils/readingText';

const SIDEBAR_WIDTH_PX = 384;

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

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
};

const getSelectionContext = (selection: Selection): { contextBefore: string; contextAfter: string } => {
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (!range) {
    return { contextBefore: '', contextAfter: '' };
  }

  const beforeRange = range.cloneRange();
  beforeRange.selectNodeContents(range.commonAncestorContainer);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeText = beforeRange.toString().slice(-48);

  const afterRange = range.cloneRange();
  afterRange.selectNodeContents(range.commonAncestorContainer);
  afterRange.setStart(range.endContainer, range.endOffset);
  const afterText = afterRange.toString().slice(0, 48);

  return {
    contextBefore: beforeText,
    contextAfter: afterText,
  };
};

const getRenderedArticle = (contentRoot: HTMLDivElement | null): HTMLElement | null => {
  if (!contentRoot) {
    return null;
  }

  return contentRoot.querySelector('article.prose');
};

const getNodePath = (root: Node, target: Node): number[] | null => {
  if (root === target) {
    return [];
  }

  const path: number[] = [];
  let current: Node | null = target;

  while (current && current !== root) {
    const parent = current.parentNode;
    if (!parent) {
      return null;
    }

    const childIndex = Array.prototype.indexOf.call(parent.childNodes, current) as number;
    if (childIndex < 0) {
      return null;
    }

    path.unshift(childIndex);
    current = parent;
  }

  return current === root ? path : null;
};

const resolveNodePath = (root: Node, path: number[]): Node | null => {
  let current: Node | null = root;

  for (const childIndex of path) {
    current = current?.childNodes.item(childIndex) ?? null;
    if (!current) {
      return null;
    }
  }

  return current;
};

const highlightRangeInArticle = (article: HTMLElement, selectionRange: Range): string | null => {
  const startPath = getNodePath(article, selectionRange.startContainer);
  const endPath = getNodePath(article, selectionRange.endContainer);
  if (!startPath || !endPath) {
    return null;
  }

  const articleClone = article.cloneNode(true) as HTMLElement;
  const clonedStartContainer = resolveNodePath(articleClone, startPath);
  const clonedEndContainer = resolveNodePath(articleClone, endPath);
  if (!clonedStartContainer || !clonedEndContainer) {
    return null;
  }

  const clonedRange = document.createRange();
  clonedRange.setStart(clonedStartContainer, selectionRange.startOffset);
  clonedRange.setEnd(clonedEndContainer, selectionRange.endOffset);

  const textSegments: Array<{ node: Text; start: number; end: number }> = [];
  const walker = document.createTreeWalker(articleClone, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.textContent) {
        return NodeFilter.FILTER_REJECT;
      }

      return clonedRange.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let currentNode = walker.nextNode();
  while (currentNode) {
    const textNode = currentNode as Text;
    const textLength = textNode.textContent?.length ?? 0;
    let start = 0;
    let end = textLength;

    if (textNode === clonedRange.startContainer) {
      start = clonedRange.startOffset;
    }

    if (textNode === clonedRange.endContainer) {
      end = clonedRange.endOffset;
    }

    if (end > start) {
      textSegments.push({ node: textNode, start, end });
    }

    currentNode = walker.nextNode();
  }

  if (textSegments.length === 0) {
    return null;
  }

  let didApplyHighlight = false;

  for (const segment of textSegments) {
    if (segment.node.parentElement?.closest('mark')) {
      continue;
    }

    let targetNode = segment.node;
    if (segment.start > 0) {
      targetNode = targetNode.splitText(segment.start);
    }

    const highlightLength = segment.end - segment.start;
    if (highlightLength <= 0) {
      continue;
    }

    if (highlightLength < (targetNode.textContent?.length ?? 0)) {
      targetNode.splitText(highlightLength);
    }

    const mark = document.createElement('mark');
    targetNode.parentNode?.replaceChild(mark, targetNode);
    mark.appendChild(targetNode);
    didApplyHighlight = true;
  }

  return didApplyHighlight ? articleClone.innerHTML : null;
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
  const groupOrder: string[] = syllabus.map(module => module.id);

  learningPlan.sections.forEach((section) => {
    const groupKey = resolveModuleId(section.id) || section.parentId || '__ungrouped__';

    if (!groupedSections.has(groupKey)) {
      groupedSections.set(groupKey, []);
      if (!groupOrder.includes(groupKey)) {
        groupOrder.push(groupKey);
      }
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
        title: moduleTitleById.get(groupKey) || (isUngrouped ? 'Percorso' : `Modulo ${index + 1}`),
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
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, selectedText: '' });
  const [contextAnswer, setContextAnswer] = useState<ContextAnswerState | null>(null);

  // Focus & Accessibility State
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [teleprompterSpeed, setTeleprompterSpeed] = useState(1); // 1 is now slow, based on user feedback
  const [isLearnMode, setIsLearnMode] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [syllabus, setSyllabus] = useState<SyllabusItem[]>([]);
  const [expandedModuleId, setExpandedModuleId] = useState<string | null>(null);
  
  // UI Visibilty States
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);

  const headerHoverBoundaryRef = useRef(64);
  const isHeaderHoveredRef = useRef(false);
  const fileUploadModeRef = useRef<'new-project' | 'reattach-source'>('new-project');

  // Refs
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const assessmentInputRef = useRef<HTMLInputElement>(null);
  const previousActiveSectionIdRef = useRef<string | null>(null);
  const highlightRangeRef = useRef<Range | null>(null);
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

  const sidebarGroups = buildSidebarGroups(learningPlan, syllabus);
  const audioDockOffset = isFocusMode ? 0 : SIDEBAR_WIDTH_PX;
  const handleModuleToggle = useCallback((groupId: string) => {
    flushSync(() => {
      setExpandedModuleId((currentId) => (currentId === groupId ? null : groupId));
    });
  }, []);

  // --- Effects ---
  
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    const shouldFocusAssessment = state === AppState.ASSESSMENT && assessmentMessages.length >= 0;

    if (shouldFocusAssessment) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      assessmentInputRef.current?.focus();
    }
  }, [assessmentMessages, state]);

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
    if (!contextMenu.visible) {
      return;
    }

    const handlePointerDown = () => {
      setContextMenu(prev => ({ ...prev, visible: false }));
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [contextMenu.visible]);

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
        await touchStoredProject(snapshot.id);
        await refreshSavedProjects();
        applySnapshotToWorkspace(snapshot);
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

  const handleOpenProject = async (projectId: string) => {
    const snapshot = await loadStoredProject(projectId);
    if (!snapshot) {
      return;
    }

    await touchStoredProject(projectId);
    await refreshSavedProjects();
    applySnapshotToWorkspace(snapshot);

    if (!snapshot.learningPlan && snapshot.file) {
      await startAssessment(snapshot.file);
      return;
    }

    if (snapshot.learningPlan) {
      const nextSection =
        snapshot.learningPlan.sections.find(section => section.id === snapshot.activeSectionId) ||
        snapshot.learningPlan.sections.find(section => !section.isCompleted) ||
        snapshot.learningPlan.sections[0];

      if (nextSection) {
        await loadSection(nextSection, snapshot.learningPlan);
      }
    }
  };

  const handleExportPlan = useCallback(async (projectId?: string) => {
    await downloadProject(projectId);
  }, [downloadProject]);

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
  }, [currentProjectId, refreshSavedProjects, resetWorkspace, savedProjects, stopAudio]);

  const handleBackToLibrary = useCallback(() => {
    stopAudio(true);
    setIsFocusMode(false);
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
      const session = GeminiService.createAssessmentChat(currentFile);
      setChatSession(session);
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
          isLearnMode: true,
          userProfile: profile,
          syllabus: newSyllabus,
          activeSectionId: firstSection.id,
          musicUrl,
        }));
        loadSection(firstSection, plan);
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
      const plan = await GeminiService.generateLearningPlan(file, history);
      setLearningPlan(plan);
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
          isLearnMode,
          userProfile,
          syllabus,
          activeSectionId: firstSection.id,
          musicUrl,
        }));
        loadSection(firstSection, plan);
      }
    } catch (err) {
      console.error("Plan generation error", err);
      alert("Errore nella generazione del piano. Riprova.");
      setState(AppState.LIBRARY); 
    } finally {
      setIsLoading(false);
    }
  };

  const loadSection = async (section: LearningSection, currentPlan: LearningPlan | null = learningPlan) => {
    if (!currentPlan) return;
    
    // 1. BLOCKING NAVIGATION if already loading another section (Fixes override issue)
    if (isLoading) return;

    // 2. Prevent reloading same section ONLY if it already has content
    if (activeSectionId === section.id && section.content && section.content.length > 0) return;
    
    // 3. IMMEDIATE RESET of Audio to prevent caching issues
    stopAudio(true);

    setActiveSectionId(section.id);
    setSectionContent('');
    setQuiz([]);
    setContextAnswer(null);
    setIsQuizSubmitted(false);
    setQuizAnswers([]);
    setNeedsSourceFile(false);
    await saveCurrentProject({ activeSectionId: section.id, state: AppState.READING });
    
    if (section.content && section.content.length > 0) {
      setSectionContent(section.content);
      if (section.quiz) {
        setQuiz(section.quiz);
        setQuizAnswers(new Array(section.quiz.length).fill(-1));
      }
      return;
    }

    // If we reach here, we need to generate content.
    // We need either a file or to be in Learn Mode (or have a syllabus to infer it)
    const hasParentIds = currentPlan.sections.some(s => !!s.parentId);
    const canGenerateInLearnMode = isLearnMode || (syllabus && syllabus.length > 0) || hasParentIds;
    
    if (!file && !canGenerateInLearnMode) {
        setNeedsSourceFile(true);
        return;
    }

    setIsLoading(true);
    setLoadingStatus("Analisi contenuti...");

    const completedTitles = currentPlan.sections
      .filter(s => s.isCompleted)
      .map(s => s.title)
      .join(", ");

    try {
      // If we don't have a file but we have parentIds, we MUST use Learn Mode generation
      if (isLearnMode || (!file && hasParentIds)) {
        if (!isLearnMode) setIsLearnMode(true); // Sync state if inferred
        const { anchorLessonContextPrompt, anchorLessonId, moduleId, moduleTitle } = resolveLearnSectionContext(section, currentPlan, syllabus);

        const content = await GeminiService.generateLearnLessonContent(
          section.title,
          moduleTitle,
          moduleId,
          anchorLessonId,
          section.contextPrompt || anchorLessonContextPrompt,
          userProfile,
          syllabus,
          (status) => setLoadingStatus(status)
        );
        
        setSectionContent(content);
        setQuiz([]);
        setQuizAnswers([]);
        const updatedPlan = {
          ...currentPlan,
          sections: currentPlan.sections.map(s => 
            s.id === section.id ? { ...s, content: content, quiz: [] } : s
          )
        };
        setLearningPlan(updatedPlan);
        await saveCurrentProject({
          learningPlan: updatedPlan,
          activeSectionId: section.id,
          state: AppState.READING,
          isLearnMode: true,
        });

      } else {
        const sourceFile = file;
        if (!sourceFile) {
          throw new Error('Missing source file for section generation');
        }

        const { content, quiz } = await GeminiService.generateSectionContent(
          sourceFile, 
          section.title, 
          section.description, 
          completedTitles,
          (status) => setLoadingStatus(status)
        );
        
        setSectionContent(content);
        setQuiz(quiz);
        setQuizAnswers(new Array(quiz.length).fill(-1));
        const updatedPlan = {
          ...currentPlan,
          sections: currentPlan.sections.map(s => 
            s.id === section.id ? { ...s, content: content, quiz: quiz } : s
          )
        };
        setLearningPlan(updatedPlan);
        await saveCurrentProject({
          learningPlan: updatedPlan,
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
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    if (selection && range && selection.toString().trim().length > 0) {
      if (contentRef.current?.contains(range.commonAncestorContainer)) {
        e.preventDefault();
        highlightRangeRef.current = range.cloneRange();
        const { contextBefore, contextAfter } = getSelectionContext(selection);
        setContextMenu({
          visible: true,
          x: e.clientX,
          y: e.clientY,
          selectedText: selection.toString(),
          contextBefore,
          contextAfter,
        });
        return;
      }
    }

    highlightRangeRef.current = null;
  }, []);

  const handleContextQuestion = async (question: string) => {
    if (!file) return;
    const { selectedText } = contextMenu;
    setIsContextLoading(true);
    try {
      const answer = await GeminiService.askContextualQuestion(file, selectedText, question);
      setContextAnswer({ q: question, a: answer });
      setContextMenu({ ...contextMenu, visible: false });
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
      const updatedPlan = { ...learningPlan, sections: newSections };
      setLearningPlan(updatedPlan);
      await saveCurrentProject({ learningPlan: updatedPlan, activeSectionId, state: AppState.READING });
      setContextMenu({ ...contextMenu, visible: false });
      await loadSection(newSection, updatedPlan);
    } catch (e) { console.error(e); alert("Impossibile creare la lezione."); } finally { setIsContextLoading(false); }
  };

  const applyStyleToSelection = () => {
      if (!activeSectionId || !learningPlan || !contentRef.current || !highlightRangeRef.current) return;

      const article = getRenderedArticle(contentRef.current);
      const range = highlightRangeRef.current.cloneRange();
      if (!article || !article.contains(range.commonAncestorContainer)) {
        highlightRangeRef.current = null;
        return;
      }

      const newContent = highlightRangeInArticle(article, range);
      if (!newContent) {
        highlightRangeRef.current = null;
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
      highlightRangeRef.current = null;
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
    setContextMenu({ ...contextMenu, visible: false });
  };

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

  if (state === AppState.LIBRARY) {
    return (
      <LibraryView
        isDarkMode={isDarkMode}
        isLibraryLoading={isLibraryLoading}
        isWorking={isLoading}
        loadingStatus={loadingStatus}
        planFileInputId={planFileInputId}
        projects={savedProjects}
        sourceFileInputId={sourceFileInputId}
        storageError={storageError}
        onDeleteProject={handleDeleteProject}
        onExportProject={(projectId) => {
          void handleExportPlan(projectId);
        }}
        onOpenProject={(projectId) => {
          void handleOpenProject(projectId);
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
    <div className="h-screen overflow-hidden flex bg-paper-light dark:bg-paper-dark font-sans transition-colors duration-300">
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
      
      <aside
        className={`fixed inset-y-0 left-0 w-96 bg-white dark:bg-zinc-900 border-r border-gray-200/80 dark:border-zinc-800 flex flex-col z-30 h-screen transition-transform duration-500 ${
          isFocusMode ? '-translate-x-full' : 'translate-x-0'
        }`}
      >
        <div className="px-6 py-5 border-b border-gray-200/80 dark:border-zinc-800 flex flex-col gap-4">
          <div className="flex justify-between items-start gap-4">
             <h1 className="font-serif font-bold text-xl text-gray-900 dark:text-white leading-tight">
              {learningPlan?.title || "Percorso di Studio"}
             </h1>
             <button 
                type="button"
                onClick={() => setIsFocusMode(true)}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 p-1 hover:bg-gray-100/80 dark:hover:bg-zinc-800 rounded-md transition-colors"
                title="Nascondi Menu (Focus Mode)"
             >
                <SidebarClose className="w-5 h-5" />
             </button>
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
                              onClick={() => loadSection(section)}
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
        className={`flex-1 relative flex flex-col min-h-0 bg-paper-light dark:bg-paper-dark transition-[margin] duration-500 ${
          isFocusMode ? 'ml-0' : 'ml-96'
        }`}
      >
        {storageError ? (
          <div className="mx-8 mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-red-200 bg-red-50/80 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
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
          <div className="mx-8 mt-5 flex items-center justify-between gap-4 rounded-2xl border border-gray-200 bg-white/90 px-4 py-3 text-sm text-gray-600 dark:border-zinc-800 dark:bg-zinc-900/90 dark:text-zinc-300">
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
                h-16 border-b border-gray-100 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 backdrop-blur 
                flex items-center px-8 justify-between flex-shrink-0 z-40 relative
                transition-opacity duration-500 ease-in-out
                ${isRulerActive && !isHeaderHovered ? 'opacity-0 hover:opacity-100' : 'opacity-100'}
            `}
        >
           <div className="flex items-center gap-4 min-w-0">
              {isFocusMode && (
                <button 
                  type="button"
                  onClick={() => setIsFocusMode(false)}
                  className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-all"
                  title="Mostra Menu"
                >
                  <SidebarOpen className="w-5 h-5" />
                </button>
              )}
           </div>
           
           <div className="flex items-center gap-6">
             {isLoading && (
               <div className="flex items-center gap-2 px-4 py-1.5 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 rounded-full text-xs font-bold animate-pulse">
                 <span className="w-2 h-2 rounded-full bg-orange-500"></span>
                 {loadingStatus.toUpperCase()}
               </div>
             )}
             
             {/* Reading Tools */}
             <div className="flex items-center bg-gray-100 dark:bg-zinc-800 rounded-full p-1 border border-gray-200 dark:border-zinc-700 transition-all shadow-sm">
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
                  <div className={`flex items-center gap-2 mx-2 animate-in fade-in zoom-in-95 border-l border-gray-300 dark:border-zinc-600 pl-2 ${audioState.isPlaying ? 'opacity-50 cursor-not-allowed grayscale' : ''}`}>
                      <Gauge className="w-3 h-3 text-gray-400" />
                      <input 
                        type="range"
                        min="0.1"
                        max="3"
                        step="0.1"
                        value={teleprompterSpeed}
                        onChange={(e) => !audioState.isPlaying && setTeleprompterSpeed(parseFloat(e.target.value))}
                        disabled={audioState.isPlaying}
                        className={`w-24 h-1.5 bg-gray-300 dark:bg-zinc-600 rounded-lg appearance-none accent-orange-600 ${audioState.isPlaying ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                        title={audioState.isPlaying ? "Velocità controllata dall'audio" : "Velocità Autoscroll"}
                      />
                      <span className="text-[10px] font-mono text-gray-500 w-8 text-right">{teleprompterSpeed.toFixed(1)}x</span>
                  </div>
               )}
             </div>
             
             {/* Music Player Control */}
             <MusicPlayer 
                url={musicUrl}
                setUrl={setMusicUrl}
                isPlaying={isMusicPlaying}
                setIsPlaying={setIsMusicPlaying}
                volume={musicVolume}
                setVolume={setMusicVolume}
             />

             <div className="w-px h-4 bg-gray-300 dark:bg-zinc-600 mx-1"></div>

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
          className="flex-1 overflow-y-auto overflow-x-hidden relative scroll-smooth"
        >
          <div className={`mx-auto py-12 px-12 pb-48 transition-all duration-500 ${isFocusMode ? 'max-w-3xl' : 'max-w-4xl'}`}>
            
            <section 
              ref={contentRef}
              className={`mb-16 min-h-[50vh] ${isAutoTrackEnabled ? 'cursor-crosshair' : ''}`}
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
                      className={`prose-xl leading-loose
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
                    <div className="text-center text-gray-400 mt-20 flex flex-col items-center">
                       <BookOpen className="w-16 h-16 opacity-20 mb-4" />
                       <p>Seleziona una sezione dal piano di studi per iniziare.</p>
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
            className="fixed bottom-24 right-8 max-w-md w-full bg-white dark:bg-zinc-900 p-6 rounded-2xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] border border-orange-100 dark:border-orange-900/30 animate-in slide-in-from-bottom-10 duration-500 z-50"
          >
             <div className="flex justify-between items-start mb-4">
               <div className="flex items-center gap-2 text-orange-600 dark:text-orange-400 text-xs font-bold uppercase tracking-wider bg-orange-50 dark:bg-orange-900/20 px-3 py-1 rounded-full">
                  <MessageSquare className="w-3 h-3" /> Risposta AI
               </div>
               <button type="button" onClick={() => setContextAnswer(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 bg-gray-50 dark:bg-zinc-800 p-1 rounded-full"><XIcon className="w-4 h-4" /></button>
              </div>
             <p className="text-base font-serif font-bold text-gray-900 dark:text-gray-100 mb-3 border-l-2 border-orange-500 pl-3">"{contextAnswer.q}"</p>
             <div className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed max-h-80 overflow-y-auto pr-2 custom-scrollbar">
                <MarkdownRenderer content={contextAnswer.a} isDarkMode={isDarkMode} className="prose-sm prose-p:text-gray-600 dark:prose-p:text-gray-300" />
             </div>
          </div>
        )}

        {contextMenu.visible && (
          <ContextMenu 
            {...contextMenu} 
            onClose={() => setContextMenu({ ...contextMenu, visible: false })}
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
