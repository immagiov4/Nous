import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import type {
  AudioPanelTab,
  ContextMenuState,
  LaboratoryExercise,
  LaboratoryStateStatus,
  LearningArtifactRenderPayload,
  LearningSection,
  LessonGeneratedVisual,
  LessonImageRef,
  OpenRouterModelDefaults,
  OpenRouterModelPreferences,
  OpenRouterModelSlot,
  PdfImageAsset,
  ProjectSource,
  QuizQuestion,
  SectionAnnotation,
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
  lessonTitle?: string;
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
  webSearch: boolean;
}

export interface SaveConversationNoteToolInput extends ConversationSelectionAnchor {
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
  activeLaboratoryExerciseId: string | null;
  activeSectionId: string | null;
  expandedModuleId: string | null;
  generatingSectionId: string | null;
  isLoading: boolean;
  isMobileViewport: boolean;
  laboratoryExercises: LaboratoryExercise[];
  laboratoryStatus: LaboratoryStateStatus | null;
  laboratoryTitle: string;
  learningPlanTitle: string;
  onBackToLibrary: () => void;
  onExportProject: () => void;
  onGenerateLaboratory: () => void;
  onRegenerateLaboratoryIndex?: () => void;
  onModuleToggle: (groupId: string) => void;
  onSelectLaboratoryExercise: (exerciseId: string) => void;
  onSelectSection: (section: LearningSection) => void;
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
  activeLaboratoryExercise: LaboratoryExercise | null;
  activeSectionId: string | null;
  activeSectionTitle: string | null;
  activeSidebarGroup: SidebarGroup | null;
  hasActiveSection: boolean;
  courseGenerationNotes: string;
  isDarkMode: boolean;
  isFocusMode: boolean;
  isLoading: boolean;
  isLaboratoryView: boolean;
  isMobileSidebarOpen: boolean;
  isMobileViewport: boolean;
  isMusicPlaying: boolean;
  isSettingsOpen: boolean;
  laboratoryTitle: string;
  learningPlanTitle: string;
  loadingStatus: string;
  modelDefaults: OpenRouterModelDefaults;
  musicUrl: string;
  musicVolume: number;
  onBackToLibrary: () => void;
  onOpenSidebar: () => void;
  onRegenerateActiveLaboratoryExercise: () => void;
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
  activeLaboratoryExercise: LaboratoryExercise | null;
  activeSectionTitle?: string | null;
  activeSectionAssetsById: Record<string, PdfImageAsset>;
  activeSectionGeneratedVisualsById?: Record<string, LessonGeneratedVisual>;
  activeSectionImageRefsById: Record<string, LessonImageRef>;
  contentRef: RefObject<HTMLDivElement | null>;
  isDarkMode: boolean;
  isFocusMode: boolean;
  isLoading: boolean;
  isLaboratoryEvaluating: boolean;
  isLaboratoryGenerating: boolean;
  isLaboratoryView: boolean;
  isMobileViewport: boolean;
  isQuizSubmitted: boolean;
  laboratoryActivityMessage?: string;
  laboratoryReasoningText?: string;
  laboratoryErrorMessage?: string;
  laboratorySourcePageRangeLabel?: string;
  laboratoryStatus: LaboratoryStateStatus | null;
  laboratorySummary: string;
  laboratoryTitle: string;
  onAddLaboratoryTextAttachment: () => void;
  onAttachLaboratoryFiles: (files: FileList | null) => void;
  onCompleteSection: () => void;
  onContentClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onContentContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onContentPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onEvaluateActiveLaboratoryExercise: () => void;
  onGenerateLaboratory: () => void;
  onRemoveLaboratoryAttachment: (attachmentId: string) => void;
  onSelectQuizAnswer: (questionIndex: number, optionIndex: number) => void;
  onSetIsQuizSubmitted: (value: boolean) => void;
  onUpdateLaboratoryAttachmentMetadata: (
    attachmentId: string,
    updates: { description?: string; name?: string }
  ) => void;
  onUpdateLaboratoryTextAttachment: (
    attachmentId: string,
    updates: { content: string; name?: string }
  ) => void;
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
  onCloseContextAnswer: () => void;
  onCloseContextMenu: () => void;
  onCreateLesson: (instructions: string) => void;
  onDeleteAnnotation: () => void;
  onHighlight: () => void;
  preferredModels: OpenRouterModelPreferences;
  onSaveConversationNote: (input: SaveConversationNoteInput) => Promise<SaveConversationNoteResult>;
  onUpdateConversationNote: (
    input: SaveConversationNoteInput
  ) => Promise<SaveConversationNoteResult>;
  onSaveNote: (note: string) => void;
}

export interface WorkspaceReaderShellProps {
  banners: WorkspaceReaderBannersModel;
  content: WorkspaceReaderContentModel;
  header: WorkspaceReaderHeaderModel;
  overlays: WorkspaceReaderOverlaysModel;
  shouldUseDesktopSidebar: boolean;
  sidebar: WorkspaceReaderSidebarModel;
}
