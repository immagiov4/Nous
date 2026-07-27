import type { UIMessage } from 'ai';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import type { GenerationProgressSnapshot } from '../../../services/openrouter/generationProgress.ts';
import type {
  ApplicationExerciseNode,
  AudioPanelTab,
  ContextMenuState,
  ContextScope,
  FileData,
  LearningArtifactRenderPayload,
  LessonContentBlock,
  LessonCreationBlockReason,
  LessonGeneratedVisual,
  LessonGeneratedVisualBlock,
  LessonImageRef,
  LessonLearningAid,
  LessonNode,
  PdfImageAsset,
  ProjectSource,
  QuizQuestion,
  ResearchSourceReference,
  SectionAnnotation,
  SectionAnnotationArtifactRef,
  SettingsPanelSectionId,
  VoiceProfileId,
} from '../../../types.ts';
import type { ResolvedLessonSourceReference } from '../../../utils/context/sourceMaterial.ts';
import type { SidebarGroup } from '../../../utils/reader/workspaceReader.ts';

export interface ContextAnswerState {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  contextScope?: ContextScope;
  id: string;
  initialQuestion: string;
  lessonContent?: string;
  lessonDescription?: string;
  lessonId?: string;
  lessonTitle?: string;
  projectId?: string;
  projectTitle?: string;
  selectedText: string;
  selectedTextStart?: number;
  sourceKind?: ProjectSource['kind'];
  sourceMaterial?: string;
  sourceName?: string;
}

export interface ConversationSelectionAnchor {
  contextAfter?: string;
  contextBefore?: string;
  selectedText: string;
  selectedTextStart?: number;
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
  canRepairApplicationExercises: boolean;
  expandedModuleId: string | null;
  generatingSectionId: string | null;
  isRepairingApplicationExercises: boolean;
  isLoading: boolean;
  isMobileViewport: boolean;
  learningPlanTitle: string;
  placement?: 'viewport' | 'container';
  repairApplicationExercisesLabel: string;
  onBackToLibrary: () => void;
  onExportProject: () => void;
  onModuleToggle: (groupId: string) => void;
  onRepairApplicationExercises: () => void;
  onSelectExercise: (exercise: ApplicationExerciseNode) => void;
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
  sourceKind?: ProjectSource['kind'];
  storageError: string | null;
}

export interface WorkspaceReaderTtsModel {
  availableVoices: WorkspaceReaderVoiceOption[];
  chunkOptions: Array<{ index: number; label: string }>;
  currentChunkIndex: number;
  currentTime: number;
  currentVoice: VoiceProfileId;
  duration: number;
  errorMessage?: string | null;
  isPlaying: boolean;
  isLoading: boolean;
  isTextPickerActive: boolean;
  playbackRate: number;
  sectionContent: string;
  ttsConnected: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSelectChunk: (chunkIndex: number) => void;
  onSetTextPickerActive: (isActive: boolean) => void;
  onSkipChunk: (direction: 'prev' | 'next') => void;
  onSpeedChange: (value: number) => void;
  onVoiceChange: (voiceId: VoiceProfileId) => void;
}

export interface WorkspaceReaderTextPickerModel {
  confirmationRects?: Array<{ height: number; left: number; top: number; width: number }>;
  hoveredChunkIndex: number | null;
  isActive: boolean;
  overlayRects: Array<{ height: number; left: number; top: number; width: number }>;
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
  learningAids: LessonLearningAid[];
  loadingStatus: string;
  musicUrl: string;
  musicVolume: number;
  onBackToLibrary: () => void;
  onOpenSidebar: () => void;
  onRegenerateActiveSection: () => void;
  onSaveLearningAids: (learningAids: LessonLearningAid[]) => Promise<boolean>;
  onSetDarkMode: (value: boolean) => void;
  onSetCourseGenerationNotes: (value: string) => void;
  onSetFocusMode: (value: boolean) => void;
  onSetIsMusicPlaying: (value: boolean) => void;
  onSetMusicUrl: (value: string) => void;
  onSetMusicVolume: (value: number) => void;
  onSetSettingsOpen: (value: boolean) => void;
  onSetSettingsPanelExpandedSections: (value: SettingsPanelSectionId[]) => void;
  settingsPanelExpandedSections: SettingsPanelSectionId[];
  syncState: 'saved' | 'saving' | 'error';
  tts: WorkspaceReaderTtsModel;
}

export interface WorkspaceReaderContentModel {
  activeExercise?: ApplicationExerciseNode | null;
  exercisePrerequisiteGaps?: Array<{ id: string; title: string }>;
  activeSectionTitle?: string | null;
  activeSectionAssetsById: Record<string, PdfImageAsset>;
  activeSectionGeneratedVisualsById?: Record<string, LessonGeneratedVisual>;
  activeSectionImageRefsById: Record<string, LessonImageRef>;
  hasNextSection: boolean;
  currentLessonArtifactPayloads?: LearningArtifactRenderPayload[];
  contentRef: RefObject<HTMLDivElement | null>;
  isDarkMode: boolean;
  isEvaluatingExercise?: boolean;
  isFocusMode: boolean;
  isLoading: boolean;
  isMobileViewport: boolean;
  isQuizSubmitted: boolean;
  learningAids: LessonLearningAid[];
  documentSourceReferences?: ResolvedLessonSourceReference[];
  loadDocumentSourceFile?: (sourceId: string) => Promise<FileData | null>;
  lessonSources?: ResearchSourceReference[];
  onAdvanceSection: () => void;
  onCompleteSection: () => void;
  onAttachExerciseFiles: (exerciseId: string, files: FileList | null) => void;
  onContentClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onContentContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onContentPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onSaveLearningAids: (learningAids: LessonLearningAid[]) => Promise<boolean>;
  onRequestExerciseFeedback: (exerciseId: string, internalText: string) => void;
  onRetryGeneratedVisual?: (block: LessonGeneratedVisualBlock) => Promise<boolean>;
  onSelectQuizAnswer: (questionIndex: number, optionIndex: number) => void;
  onRemoveExerciseAttachment: (exerciseId: string, attachmentId: string) => void;
  onSetIsQuizSubmitted: (value: boolean) => void;
  onUpdateExerciseInternalText: (exerciseId: string, text: string) => void;
  quiz: QuizQuestion[];
  quizAnswers: number[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  sectionAnnotations?: SectionAnnotation[];
  sectionContent: string;
  sectionContentBlocks?: LessonContentBlock[];
  exerciseFeedbackError?: string;
  exerciseFeedbackStatus?: string;
  ttsTextPicker: WorkspaceReaderTextPickerModel;
  scrollMode?: 'contained' | 'document';
  sectionReasoningText?: string;
  sectionProgress?: GenerationProgressSnapshot;
  sourcePageRangeLabel?: string;
}

export interface WorkspaceReaderOverlaysModel {
  contextAnswerArtifactActionFeedbackOverride?: 'saved';
  contextAnswerArtifactPreviewIdOverride?: string | null;
  contextAnswerArtifactPortalContainer?: HTMLElement | null;
  contextAnswerAutoScrollKey?: string;
  contextAnswer: ContextAnswerState | null;
  contextAnswerDisplayMessages?: UIMessage[];
  contextAnswerPanelRef: RefObject<HTMLDivElement | null>;
  contextAnswerResizePreviewRef: RefObject<HTMLDivElement | null>;
  contextAnswerSize: ContextAnswerSize;
  contextAnswerInputValue?: string;
  contextAnswerMessagesScrollTopOverride?: number;
  contextMenu: ContextMenuState;
  contextMenuAskInputValue?: string;
  contextMenuArtifactPreviewIdOverride?: string | null;
  contextMenuArtifactPortalContainer?: HTMLElement | null;
  contextMenuMotionProgressOverride?: number;
  contextMenuNotePreviewScrollTopOverride?: number;
  contextMenuRef: RefObject<HTMLDivElement | null>;
  handleContextAnswerResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  isContextLoading: boolean;
  isDarkMode: boolean;
  isMobileViewport: boolean;
  lessonCreationBlockReason: LessonCreationBlockReason | null;
  currentLessonArtifactPayloads?: LearningArtifactRenderPayload[];
  onAskContextQuestion: (question: string) => void;
  onAttachArtifactToAnnotation: (artifactRef: SectionAnnotationArtifactRef) => void;
  onCloseContextAnswer: () => void;
  onCloseContextMenu: () => void;
  onCreateLesson: (instructions: string) => void;
  onDeleteAnnotation: () => void;
  onDetachArtifactFromAnnotation: (artifactId: string) => void;
  onHighlight: () => void;
  onSaveConversationNote: (input: SaveConversationNoteInput) => Promise<SaveConversationNoteResult>;
  onUpdateConversationNote: (
    input: SaveConversationNoteInput
  ) => Promise<SaveConversationNoteResult>;
  onSaveNote: (note: string, artifactRefs?: SectionAnnotationArtifactRef[]) => void;
  onSaveArtifactToLesson?: (
    visual: LessonGeneratedVisual,
    artifactRef: { artifactId: string; kind: 'generated-visual'; title: string }
  ) => Promise<void>;
  onReplaceArtifactInLesson?: (artifactId: string, visual: LessonGeneratedVisual) => Promise<void>;
}

export interface WorkspaceReaderShellProps {
  banners: WorkspaceReaderBannersModel;
  content: WorkspaceReaderContentModel;
  displayMode?: 'application' | 'embedded';
  header: WorkspaceReaderHeaderModel;
  overlays: WorkspaceReaderOverlaysModel;
  shouldUseDesktopSidebar: boolean;
  sidebar: WorkspaceReaderSidebarModel;
}
