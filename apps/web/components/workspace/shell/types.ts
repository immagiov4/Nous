import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import type {
  AudioPanelTab,
  ContextMenuState,
  LearningArtifactRenderPayload,
  LessonGeneratedVisual,
  LessonImageRef,
  LessonNode,
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
  PdfImageAsset,
  ProjectSource,
  QuizQuestion,
  SectionAnnotation,
  SectionAnnotationArtifactRef,
  SettingsPanelSectionId,
  VoiceProfileId,
} from '../../../types.ts';
import type { SidebarGroup } from '../../../utils/reader/workspaceReader.ts';

export interface ContextAnswerState {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  id: string;
  initialQuestion: string;
  lessonContent?: string;
  lessonDescription?: string;
  lessonId?: string;
  lessonTitle?: string;
  projectId?: string;
  projectTitle?: string;
  selectedText: string;
  sourceKind?: ProjectSource['kind'];
  sourceMaterial?: string;
  sourceName?: string;
}

export interface ConversationSelectionAnchor {
  contextAfter?: string;
  contextBefore?: string;
  selectedText: string;
}

export interface ContextChatToolPreferences {
  annotate: boolean;
  generateArtifacts: boolean;
  webSearch: boolean;
}

export interface SaveConversationNoteToolInput extends ConversationSelectionAnchor {
  artifactRefs?: SectionAnnotationArtifactRef[];
  generatedVisuals?: LessonGeneratedVisual[];
  note: string;
}

export interface SaveConversationNoteInput extends SaveConversationNoteToolInput {
  fallbackSelection?: ConversationSelectionAnchor;
}

export interface SaveConversationNoteResult {
  annotationId?: string;
  error?: string;
  merged: boolean;
  resolvedText?: string;
  saved: boolean;
}

export interface ContextAnswerSize {
  width: number;
  height: number;
}

export interface WorkspaceReaderVoiceOption {
  id: VoiceProfileId;
  label: string;
  language: string;
}

export interface WorkspaceReaderSidebarModel {
  activeSectionId: string | null;
  expandedModuleId: string | null;
  generatingSectionId: string | null;
  isLoading: boolean;
  isMobileViewport: boolean;
  learningPlanTitle: string;
  onBackToLibrary: () => void;
  onExportProject: () => void;
  onModuleToggle: (groupId: string) => void;
  onSelectSection: (section: LessonNode) => void;
  onSetFocusMode: (value: boolean) => void;
  onSetIsMobileSidebarOpen: (value: boolean) => void;
  shouldShowSidebar: boolean;
  sidebarGroups: SidebarGroup[];
}

export interface WorkspaceReaderBannersModel {
  pdfMappingWarning: string | null;
  needsSourceFile: boolean;
  onAttachSourceFile: () => void;
  onBackToLibrary: () => void;
  onExportProject: () => void;
  storageError: string | null;
}

export interface WorkspaceReaderTtsModel {
  availableVoices: WorkspaceReaderVoiceOption[];
  currentTime: number;
  currentVoice: VoiceProfileId;
  duration: number;
  isPlaying: boolean;
  isLoading: boolean;
  playbackRate: number;
  sectionContent: string;
  ttsConnected: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSkipChunk: (direction: 'prev' | 'next') => void;
  onSpeedChange: (value: number) => void;
  onVoiceChange: (voiceId: VoiceProfileId) => void;
}

export interface WorkspaceReaderHeaderModel {
  lastAudioTab: AudioPanelTab;
  onSetLastAudioTab: (tab: AudioPanelTab) => void;
  activeSectionId: string | null;
  activeSectionTitle: string | null;
  activeSidebarGroup: SidebarGroup | null;
  hasActiveSection: boolean;
  courseGenerationNotes: string;
  isDarkMode: boolean;
  isFocusMode: boolean;
  isLoading: boolean;
  isMobileSidebarOpen: boolean;
  isMobileViewport: boolean;
  isMusicPlaying: boolean;
  isSettingsOpen: boolean;
  learningPlanTitle: string;
  loadingStatus: string;
  modelDefaults: OpenRouterModelDefaults;
  musicUrl: string;
  musicVolume: number;
  onBackToLibrary: () => void;
  onOpenSidebar: () => void;
  onRegenerateActiveSection: () => void;
  onSetDarkMode: (value: boolean) => void;
  onSetCourseGenerationNotes: (value: string) => void;
  onSetFocusMode: (value: boolean) => void;
  onSetIsMusicPlaying: (value: boolean) => void;
  onSetMusicUrl: (value: string) => void;
  onSetMusicVolume: (value: number) => void;
  onSetPreferredOpenRouterModel: (slot: OpenRouterModelSlot, value: string) => void;
  onSetSettingsOpen: (value: boolean) => void;
  onSetSettingsPanelExpandedSections: (value: SettingsPanelSectionId[]) => void;
  preferredModels: OpenRouterModelPreferences;
  settingsPanelExpandedSections: SettingsPanelSectionId[];
  syncState: 'saved' | 'saving' | 'error';
  tts: WorkspaceReaderTtsModel;
}

export interface WorkspaceReaderContentModel {
  activeSectionTitle?: string | null;
  activeSectionAssetsById: Record<string, PdfImageAsset>;
  activeSectionGeneratedVisualsById?: Record<string, LessonGeneratedVisual>;
  activeSectionImageRefsById: Record<string, LessonImageRef>;
  currentLessonArtifactPayloads?: LearningArtifactRenderPayload[];
  contentRef: RefObject<HTMLDivElement | null>;
  isDarkMode: boolean;
  isFocusMode: boolean;
  isLoading: boolean;
  isMobileViewport: boolean;
  isQuizSubmitted: boolean;
  onCompleteSection: () => void;
  onContentClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onContentContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onContentPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onSelectQuizAnswer: (questionIndex: number, optionIndex: number) => void;
  onSetIsQuizSubmitted: (value: boolean) => void;
  quiz: QuizQuestion[];
  quizAnswers: number[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  sectionAnnotations?: SectionAnnotation[];
  sectionContent: string;
  sectionReasoningText?: string;
  sourcePageRangeLabel?: string;
}

export interface WorkspaceReaderOverlaysModel {
  contextAnswer: ContextAnswerState | null;
  contextAnswerPanelRef: RefObject<HTMLDivElement | null>;
  contextAnswerResizePreviewRef: RefObject<HTMLDivElement | null>;
  contextAnswerSize: ContextAnswerSize;
  contextMenu: ContextMenuState;
  contextMenuRef: RefObject<HTMLDivElement | null>;
  handleContextAnswerResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  isContextLoading: boolean;
  isDarkMode: boolean;
  isMobileViewport: boolean;
  currentLessonArtifactPayloads?: LearningArtifactRenderPayload[];
  onAskContextQuestion: (question: string) => void;
  onAttachArtifactToAnnotation: (artifactRef: SectionAnnotationArtifactRef) => void;
  onCloseContextAnswer: () => void;
  onCloseContextMenu: () => void;
  onCreateLesson: (instructions: string) => void;
  onDeleteAnnotation: () => void;
  onDetachArtifactFromAnnotation: (artifactId: string) => void;
  onHighlight: () => void;
  preferredModels: OpenRouterModelPreferences;
  onSaveConversationNote: (input: SaveConversationNoteInput) => Promise<SaveConversationNoteResult>;
  onUpdateConversationNote: (
    input: SaveConversationNoteInput
  ) => Promise<SaveConversationNoteResult>;
  onSaveNote: (note: string) => void;
  onSaveArtifactToLesson?: (
    visual: LessonGeneratedVisual,
    artifactRef: { artifactId: string; kind: 'generated-visual'; title: string }
  ) => Promise<void>;
}

export interface WorkspaceReaderShellProps {
  banners: WorkspaceReaderBannersModel;
  content: WorkspaceReaderContentModel;
  header: WorkspaceReaderHeaderModel;
  overlays: WorkspaceReaderOverlaysModel;
  shouldUseDesktopSidebar: boolean;
  sidebar: WorkspaceReaderSidebarModel;
}
