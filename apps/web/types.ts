export interface UserProfile {
  topic: string;
  experienceLevel: string;
  learningStyle: string;
  goals: string;
  context: string;
  language: string;
}

export interface SyllabusItem {
  id: string;
  title: string;
  description: string;
  type: 'module' | 'lesson';
  status: 'pending' | 'ready';
  contextPrompt?: string;
  children?: SyllabusItem[];
}

export interface ResearchSourceReference {
  title: string;
  url?: string;
  note?: string;
}

export interface ResearchLessonPlan {
  description: string;
  guidingQuestions: string[];
  id: string;
  keyConcepts: string[];
  miniLab: string;
  moduleId: string;
  moduleTitle: string;
  prerequisites: string[];
  simplificationRisks: string[];
  sourceHints: ResearchSourceReference[];
  title: string;
}

export interface ResearchCoursePlan {
  generatedAt: string;
  lessonCountReason: string;
  lessons: ResearchLessonPlan[];
  summary: string;
  title: string;
}

export interface ResearchLessonDossier {
  avoidOversimplifying: string[];
  controversies: string[];
  difficultSteps: string[];
  factualSummary: string;
  generatedAt: string;
  keyExamples: string[];
  recentDevelopments: string[];
  sectionId: string;
  sources: ResearchSourceReference[];
  title: string;
}

export type ResearchDossiersBySectionId = Record<string, ResearchLessonDossier>;

export interface FileData {
  name: string;
  mimeType: string;
  data: string; // Base64
  sourceId?: string;
}

export interface SourceOutlineNode {
  children: SourceOutlineNode[];
  endOffset?: number;
  id: string;
  level: number;
  page?: number;
  startOffset?: number;
  title: string;
}

export interface CourseSourceDescriptor {
  documentIndex?: PdfTextIndex | null;
  errorMessage?: string;
  file: FileData;
  hash: string;
  id: string;
  kind: 'markdown' | 'pdf' | 'text';
  name: string;
  outline: SourceOutlineNode[];
  outlineOrigin: 'deterministic' | 'native' | 'none';
  position: number;
  status: 'error' | 'partial' | 'ready';
}

export interface CodebaseSourceFile {
  path: string;
  text: string;
  truncated?: boolean;
}

export interface CodebaseBundleStats {
  includedFileCount: number;
  skippedFileCount: number;
  truncatedFileCount: number;
  totalCharacterCount: number;
}

export interface ProjectSourceRef {
  byteSize: number;
  hash: string;
  id: string;
  mimeType: string;
  name: string;
}

export interface PdfProjectSource {
  kind: 'pdf';
  file: FileData;
  ref?: ProjectSourceRef;
  sources?: CourseSourceDescriptor[];
}

export interface CodebaseBundleSource {
  kind: 'codebase-bundle';
  name: string;
  aggregatedText: string;
  files: CodebaseSourceFile[];
  stats: CodebaseBundleStats;
  sources?: CourseSourceDescriptor[];
}

export type ProjectSource = PdfProjectSource | CodebaseBundleSource;

export const AppState = {
  LIBRARY: 'LIBRARY',
  ASSESSMENT: 'ASSESSMENT',
  PLANNING: 'PLANNING',
  READING: 'READING',
} as const;

export type AppState = (typeof AppState)[keyof typeof AppState];

export type {
  LibraryFolder,
  LibraryPlacement,
  ProjectId,
  ProjectPatch,
  ProjectRevisionEvent,
  ProjectSourceKind,
  ProjectSyncState,
  ProjectWriteOptions,
  SavedProjectMeta,
  SectionPatch,
} from '@shared/projectContract';

import type {
  LibraryFolder,
  LibraryPlacement,
  ProjectId,
  ProjectSourceKind,
  SavedProjectMeta,
} from '@shared/projectContract';

export interface Message {
  role: 'user' | 'model';
  text: string;
}

export type HomeChatMode = 'new-course' | 'library-query';

export interface LibraryContextRef {
  id: string;
  kind: 'folder' | 'project';
  label: string;
}

export interface HomeChatToolPreferences {
  addingAssessmentDetails?: boolean;
  attachedContextRefs?: LibraryContextRef[];
  generateArtifacts?: boolean;
  mode: HomeChatMode;
  newCourse: boolean;
  webSearch?: boolean;
}

export interface LibraryProjectNode {
  id: ProjectId;
  kind: 'project';
  order: number;
  project: SavedProjectMeta;
}

export interface LibraryFolderNode {
  id: string;
  kind: 'folder';
  order: number;
  folder: LibraryFolder;
  children: LibraryTreeNode[];
  descendantProjectIds: ProjectId[];
}

export type LibraryTreeNode = LibraryFolderNode | LibraryProjectNode;

export interface LibraryTree {
  descendantProjectIdsByFolderId: Record<string, ProjectId[]>;
  folderById: Record<string, LibraryFolder>;
  placementByProjectId: Record<ProjectId, LibraryPlacement>;
  rootNodes: LibraryTreeNode[];
}

export interface LibraryScopeSummary {
  attachedFolderIds: string[];
  attachedProjectIds: ProjectId[];
  contextLabels: string[];
  isWholeLibraryScope: boolean;
  scopeProjectIds: ProjectId[];
  scopeSummary: string;
}

export const ACTIVE_PAUSE_EXERCISE_TYPES = [
  'concept-check',
  'application-card',
  'prediction',
  'error-diagnosis',
  'classification',
  'compare-contrast',
  'sequence',
  'micro-synthesis',
] as const;

export type ActivePauseExerciseType = (typeof ACTIVE_PAUSE_EXERCISE_TYPES)[number];

export interface QuizQuestion {
  exerciseType?: ActivePauseExerciseType;
  question: string;
  options: string[];
  correctIndex: number;
}

export interface LessonImageRef {
  assetId: string;
  alt: string;
  caption?: string;
  anchorHeading?: string;
}

export type LessonLearningAidKind = 'definition' | 'formula' | 'symbol' | 'analogy';

export interface LessonLearningAid {
  id: string;
  kind: LessonLearningAidKind;
  title: string;
  content: string;
  anchorHeading?: string;
}

export type GeneratedRasterMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export type LessonGeneratedVisualKind = 'svg' | 'html' | 'image' | 'mermaid';

export interface LessonGeneratedVisual {
  id: string;
  title: string;
  kind: LessonGeneratedVisualKind;
  code: string;
  diagramType?: 'erDiagram' | 'classDiagram';
  altText?: string;
  mediaType?: GeneratedRasterMediaType;
  loadingMessages?: string[];
  anchorHeading?: string;
  createdAt: string;
}

export type LearningArtifactKind = 'future-asset' | 'generated-visual' | 'pdf-image';
export type LearningArtifactPreviewMode = 'chip-only' | 'thumbnail';

export interface LearningArtifactSummary {
  createdAt?: string;
  description?: string;
  id: string;
  kind: LearningArtifactKind;
  lessonId: string;
  lessonTitle: string;
  previewMode: LearningArtifactPreviewMode;
  projectId: ProjectId;
  projectTitle: string;
  replacementOfArtifactId?: string;
  sourceLabel?: string;
  title: string;
}

export type LearningArtifactRenderPayload =
  | {
      image: PdfImageAsset;
      searchText?: string;
      summary: LearningArtifactSummary & {
        kind: 'pdf-image';
      };
    }
  | {
      summary: LearningArtifactSummary & {
        kind: 'generated-visual';
      };
      searchText?: string;
      visual: LessonGeneratedVisual;
    }
  | {
      searchText?: string;
      summary: LearningArtifactSummary & {
        kind: 'future-asset';
      };
    };

export interface PdfTextPage {
  pageNumber: number;
  text: string;
}

export interface PdfImageAsset {
  id: string;
  mimeType: string;
  dataUrl: string;
  caption?: string;
  textBefore: string;
  textCurrent?: string;
  textAfter: string;
  sourceOrder: number;
  pageNumber?: number;
}

export interface PdfDocumentAssets {
  kind: 'pdf';
  parsedAt: string;
  imageCount: number;
  sourceHash?: string;
  usedImages: PdfImageAsset[];
}

export interface PdfTextChunk {
  id: string;
  text: string;
  headingPath: string[];
  sequence: number;
  startOffset: number;
  endOffset: number;
  pageStart?: number;
  pageEnd?: number;
  sourceId?: string;
}

export interface PdfTextIndex {
  kind: 'pdf-text-index';
  parsedAt: string;
  sourceHash?: string;
  sourceIds?: string[];
  documentTitle?: string;
  pageCount?: number;
  mappingQuality?: {
    coverageRatio?: number;
    gapCount?: number;
    lessonCount?: number;
    mappedLessonCount?: number;
    mappingSource: 'fallback' | 'mapped';
    updatedAt: string;
  };
  mappingRecovery?: {
    status: 'exhausted';
    updatedAt: string;
  };
  mappingWarnings?: string[];
  chunks: PdfTextChunk[];
}

export interface LessonSourceReference {
  chunkIds: string[];
  pageEnd?: number;
  pageStart?: number;
  sourceId: string;
}

export interface LearningSection {
  id: string;
  moduleTitle?: string;
  title: string;
  description: string;
  isCompleted: boolean;
  type: 'prerequisite' | 'core' | 'summary' | 'deep-dive';
  parentId?: string; // ID of the parent section if this is a sub-chapter
  content?: string; // The generated full lesson content (persisted)
  quiz?: QuizQuestion[]; // The generated quiz (persisted)
  imageRefs?: LessonImageRef[]; // PDF image references selected for this lesson
  generatedVisuals?: LessonGeneratedVisual[]; // Generated pedagogical visuals for missing examples
  learningAids?: LessonLearningAid[]; // Compact definitions, formulas, symbols, and analogies
  contextPrompt?: string; // For Learn Mode
  primaryChunkIds?: string[]; // Primary source chunks for PDF-backed lesson generation
  primaryChunkMappingSource?: 'fallback' | 'mapped';
  sourceReferences?: LessonSourceReference[];
  annotations?: SectionAnnotation[]; // Persistent text annotations/highlights for the section
}

export interface LearningPlan {
  title: string;
  summary: string;
  modules: LearningModule[];
  applicationExercisePlanningStatus: ApplicationExercisePlanningStatus;
  applicationExercisePlanningNotes?: string;
  applicationExercisePlanningError?: ApplicationExercisePlanningError;
  backgroundMusicUrl?: string; // Optional field for YouTube background music
  generationNotes?: string; // Per-course user notes that steer lesson generation style/tone
}

// === Application exercises (new path nodes) ===

export type ExerciseAttachmentKind = 'archive' | 'text';

export interface ExerciseAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: ExerciseAttachmentKind;
  data: string; // plain text for kind='text'; base64 for kind='archive'
  description?: string;
  truncated: boolean;
  truncatedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExerciseFeedback {
  evaluatedAt: string;
  score: number;
  qualitativeLabel: string;
  summary: string;
  strengths: string[];
  improvements: string[];
  caveats: string[];
  verifiedSources?: ResearchSourceReference[];
}

export interface ApplicationExerciseNode {
  kind: 'exercise';
  id: string;
  title: string;
  description: string;
  assessedObjective: string;
  brief?: string;
  internalText?: string;
  attachments: ExerciseAttachment[];
  currentFeedback: ExerciseFeedback | null;
  bestScore?: number;
  completedAt?: string;
  isCompleted: boolean;
  feedbackStale: boolean;
  groundingSources?: ResearchSourceReference[];
  generatedAt?: string;
  updatedAt: string;
}

export interface LessonNode extends Omit<LearningSection, 'moduleTitle'> {
  kind: 'lesson';
}

export type PathNode = LessonNode | ApplicationExerciseNode;

export interface LearningModule {
  id: string;
  title: string;
  description?: string;
  type?: 'prerequisite' | 'core' | 'summary' | 'deep-dive';
  children: PathNode[];
}

export type ApplicationExercisePlanningStatus = 'not-run' | 'completed' | 'failed';

export interface ApplicationExercisePlanningError {
  message: string;
  attempts: number;
  lastAttemptAt: string;
}

export interface ProjectSnapshot {
  id: ProjectId;
  version: string;
  sourceKind: ProjectSourceKind;
  state: AppState;
  source: ProjectSource | null;
  learningPlan: LearningPlan | null;
  isLearnMode: boolean;
  userProfile: UserProfile | null;
  syllabus: SyllabusItem[];
  researchCoursePlan?: ResearchCoursePlan | null;
  researchDossiersBySectionId?: ResearchDossiersBySectionId;
  activeSectionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  documentAssets?: PdfDocumentAssets | null;
  documentIndex?: PdfTextIndex | null;
}

export interface ProjectExportData {
  id?: ProjectId;
  version: string;
  state?: AppState;
  file?: FileData | null; // Legacy import fallback for older exports
  source?: ProjectSource | null;
  learningPlan: LearningPlan | null;
  isLearnMode: boolean;
  userProfile: UserProfile | null;
  syllabus: SyllabusItem[];
  researchCoursePlan?: ResearchCoursePlan | null;
  researchDossiersBySectionId?: ResearchDossiersBySectionId;
  activeSectionId?: string | null;
  musicUrl?: string;
  sourceKind?: ProjectSourceKind;
  documentAssets?: PdfDocumentAssets | null;
  documentIndex?: PdfTextIndex | null;
}

export type OpenRouterModelSlot =
  | 'lesson'
  | 'assessment'
  | 'context'
  | 'progress'
  | 'research'
  | 'tts';
export type SettingsPanelSectionId = 'course-notes';

export type AudioPanelTab = 'voce' | 'ambiente';
export const DEFAULT_AUDIO_PANEL_TAB: AudioPanelTab = 'voce';

export interface UiPreferences {
  isDarkMode: boolean;
  lastAudioTab: AudioPanelTab;
  preferredVoice: VoiceProfileId;
  playbackRate: number;
  preferredTtsVoice: VoiceProfileId;
  settingsPanelExpandedSections: SettingsPanelSectionId[];
}

export interface SelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface HorizontalViewportBounds {
  left: number;
  right: number;
}

export type ContextMenuPlacement = 'desktop-floating' | 'mobile-sheet';
export type ContextScope = 'annotation' | 'lesson' | 'selection';

export type SectionAnnotationAnchor = { kind: 'lesson' } | { kind: 'selection' };

export interface SectionAnnotationArtifactRef {
  artifactId: string;
  kind: LearningArtifactKind;
  title?: string;
}

export interface SectionAnnotation {
  anchor?: SectionAnnotationAnchor;
  artifactRefs?: SectionAnnotationArtifactRef[];
  id: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

interface BaseContextMenuState {
  visible: boolean;
  placement: ContextMenuPlacement;
  selectedText: string;
  anchorX?: number;
  anchorY?: number;
  horizontalBounds?: HorizontalViewportBounds;
  selectionRect?: SelectionRect;
}

export interface SelectionContextMenuState extends BaseContextMenuState {
  type: 'selection';
  contextBefore?: string;
  contextAfter?: string;
}

export interface LessonContextMenuState extends BaseContextMenuState {
  type: 'lesson';
  contextBefore?: string;
  contextAfter?: string;
}

export interface AnnotationContextMenuState extends BaseContextMenuState {
  type: 'annotation';
  annotationId: string;
  annotationArtifactRefs?: SectionAnnotationArtifactRef[];
  annotationNote: string;
  contextBefore?: string;
  contextAfter?: string;
}

export type ContextMenuState =
  | AnnotationContextMenuState
  | LessonContextMenuState
  | SelectionContextMenuState;

export type VoiceProfileId = string;
export type VoiceName = VoiceProfileId;

export interface TtsModelSummary {
  contextLength: number;
  id: string;
  name: string;
  pricing: {
    completion: string;
    prompt: string;
  };
  supportedParameters: string[];
  supportsVoiceCloning: boolean;
  voiceHelpLabel?: string;
  voiceHelpUrl?: string;
}

export interface AudioChunk {
  text: string;
  index: number;
  blobUrl: string | null;
  duration: number; // in seconds, known only after metadata loads
  isLoading: boolean;
}

export interface AudioState {
  isPlaying: boolean;
  currentVoice: VoiceProfileId;
  currentModel: string;
  playbackRate: number;
  chunks: AudioChunk[];
  currentChunkIndex: number;
  audioElement: HTMLAudioElement | null;
}

export interface WorkspaceDomainState {
  source: ProjectSource | null;
  learningPlan: LearningPlan | null;
  documentAssets: PdfDocumentAssets | null;
  documentIndex: PdfTextIndex | null;
  isLearnMode: boolean;
  userProfile: UserProfile | null;
  syllabus: SyllabusItem[];
  researchCoursePlan?: ResearchCoursePlan | null;
  researchDossiersBySectionId?: ResearchDossiersBySectionId;
  activeSectionId: string | null;
}
