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

export interface FileData {
  name: string;
  mimeType: string;
  data: string; // Base64
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

export interface PdfProjectSource {
  kind: 'pdf';
  file: FileData;
}

export interface CodebaseBundleSource {
  kind: 'codebase-bundle';
  name: string;
  aggregatedText: string;
  files: CodebaseSourceFile[];
  stats: CodebaseBundleStats;
}

export type ProjectSource = PdfProjectSource | CodebaseBundleSource;

export const AppState = {
  LIBRARY: 'LIBRARY',
  ASSESSMENT: 'ASSESSMENT',
  PLANNING: 'PLANNING',
  READING: 'READING',
} as const;

export type AppState = (typeof AppState)[keyof typeof AppState];

export type ProjectId = string;
export type ProjectSourceKind = 'document' | 'codebase' | 'learn-mode' | 'imported-json';
export type ProjectSyncState = 'local-only' | 'sync-ready' | 'sync-error';

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
  attachedContextRefs?: LibraryContextRef[];
  mode: HomeChatMode;
  newCourse: boolean;
  webSearch?: boolean;
}

export interface LibraryFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
  order: number;
}

export interface LibraryPlacement {
  projectId: ProjectId;
  folderId: string | null;
  order: number;
  updatedAt: string;
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

export interface QuizQuestion {
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
}

export interface PdfTextIndex {
  kind: 'pdf-text-index';
  parsedAt: string;
  sourceHash?: string;
  documentTitle?: string;
  pageCount?: number;
  chunks: PdfTextChunk[];
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
  contextPrompt?: string; // For Learn Mode
  primaryChunkIds?: string[]; // Primary source chunks for PDF-backed lesson generation
  primaryChunkMappingSource?: 'fallback' | 'mapped';
  annotations?: SectionAnnotation[]; // Persistent text annotations/highlights for the section
}

export interface LearningPlan {
  title: string;
  summary: string;
  sections: LearningSection[];
  backgroundMusicUrl?: string; // Optional field for YouTube background music
  generationNotes?: string; // Per-course user notes that steer lesson generation style/tone
}

export type LaboratoryAttachmentKind = 'archive' | 'binary' | 'image' | 'text';
export type LaboratoryStateStatus = 'failed' | 'idle' | 'pending' | 'ready';

export interface LaboratoryAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: LaboratoryAttachmentKind;
  data: string; // Base64
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LaboratoryExerciseEvaluation {
  caveats: string[];
  confidenceScore: number;
  confidenceSummary: string;
  evaluatedAt: string;
  improvements: string[];
  score: number;
  strengths: string[];
  summary: string;
}

export interface LaboratoryExercise {
  attachments: LaboratoryAttachment[];
  approachMarkdown: string;
  brief: string;
  evaluation: LaboratoryExerciseEvaluation | null;
  exampleMarkdown: string;
  generatedAt: string;
  id: string;
  internalNotes: string[];
  instructionsMarkdown: string;
  requirements: string[];
  sourceChunkIds?: string[];
  title: string;
  updatedAt: string;
}

export interface LaboratoryState {
  errorMessage?: string;
  exercises: LaboratoryExercise[];
  generatedAt?: string;
  schemaVersion: number;
  status: LaboratoryStateStatus;
  summary: string;
  title: string;
  updatedAt: string;
}

export interface SavedProjectMeta {
  id: ProjectId;
  title: string;
  sourceKind: ProjectSourceKind;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  lessonCount: number;
  completedCount: number;
  hasSourceFile: boolean;
  coverLabel: string;
  syncState: ProjectSyncState;
}

export interface ProjectSnapshot {
  id: ProjectId;
  version: string;
  sourceKind: ProjectSourceKind;
  state: AppState;
  source: ProjectSource | null;
  learningPlan: LearningPlan | null;
  laboratory: LaboratoryState | null;
  isLearnMode: boolean;
  userProfile: UserProfile | null;
  syllabus: SyllabusItem[];
  activeSectionId: string | null;
  activeLaboratoryExerciseId: string | null;
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
  laboratory?: LaboratoryState | null;
  isLearnMode: boolean;
  userProfile: UserProfile | null;
  syllabus: SyllabusItem[];
  activeSectionId?: string | null;
  activeLaboratoryExerciseId?: string | null;
  musicUrl?: string;
  sourceKind?: ProjectSourceKind;
  documentAssets?: PdfDocumentAssets | null;
  documentIndex?: PdfTextIndex | null;
}

export type OpenRouterModelSlot = 'lesson' | 'assessment' | 'context';

export interface OpenRouterModelDefaults {
  lessonModel: string;
  assessmentModel: string;
  contextModel: string;
}

export interface OpenRouterModelPreferences {
  preferredLessonModel: string;
  preferredAssessmentModel: string;
  preferredContextModel: string;
}

export interface UiPreferences extends OpenRouterModelPreferences {
  isDarkMode: boolean;
  preferredVoice: VoiceProfileId;
  playbackRate: number;
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

export interface SectionAnnotation {
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

export interface AnnotationContextMenuState extends BaseContextMenuState {
  type: 'annotation';
  annotationId: string;
  annotationNote: string;
}

export type ContextMenuState = SelectionContextMenuState | AnnotationContextMenuState;

export type VoiceProfileId = 'mario';
export type VoiceName = VoiceProfileId;

// TTS Status interface
export interface TTSStatus {
  isRunning: boolean;
  isReady: boolean;
  modelLoaded: boolean;
  currentDevice: string;
  uptime: number;
  lastError?: string;
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
  playbackRate: number;
  chunks: AudioChunk[];
  currentChunkIndex: number;
  audioElement: HTMLAudioElement | null;
}

export interface WorkspaceDomainState {
  source: ProjectSource | null;
  learningPlan: LearningPlan | null;
  laboratory: LaboratoryState | null;
  documentAssets: PdfDocumentAssets | null;
  documentIndex: PdfTextIndex | null;
  isLearnMode: boolean;
  userProfile: UserProfile | null;
  syllabus: SyllabusItem[];
  activeSectionId: string | null;
  activeLaboratoryExerciseId: string | null;
}
