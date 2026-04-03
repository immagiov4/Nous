import {
  AppState,
  type CodebaseBundleSource,
  type FileData,
  type LearningPlan,
  type PdfDocumentAssets,
  type PdfTextIndex,
  type ProjectExportData,
  type ProjectId,
  type ProjectSnapshot,
  type ProjectSource,
  type ProjectSourceKind,
  type SavedProjectMeta,
  type SyllabusItem,
  type UserProfile,
} from '../types.ts';
import {
  createProjectSourceFromFile,
  getProjectSourceFile,
  getProjectSourceName,
  isDocumentProjectSource,
  isPdfFileData,
} from './projectSource.ts';

const CURRENT_PROJECT_VERSION = '4.1';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isString = (value: unknown): value is string => typeof value === 'string';

const ensureString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

export const createProjectId = (): ProjectId => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `project-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

export const inferProjectSourceKind = (
  snapshot: Pick<ProjectSnapshot, 'source' | 'isLearnMode'>,
  imported = false
): ProjectSourceKind => {
  if (snapshot.isLearnMode) {
    return 'learn-mode';
  }

  if (isDocumentProjectSource(snapshot.source)) {
    return 'document';
  }

  if (snapshot.source?.kind === 'codebase-bundle') {
    return 'codebase';
  }

  if (snapshot.source) {
    return 'document';
  }

  return imported ? 'imported-json' : 'document';
};

export const getProjectTitle = (
  snapshot: Pick<ProjectSnapshot, 'learningPlan' | 'source' | 'userProfile' | 'isLearnMode'>
): string => {
  const planTitle = snapshot.learningPlan?.title?.trim();
  if (planTitle) {
    return planTitle;
  }

  const userTopic = snapshot.userProfile?.topic?.trim();
  if (userTopic) {
    return userTopic;
  }

  const sourceName = getProjectSourceName(snapshot.source).trim();
  if (sourceName) {
    return sourceName;
  }

  return snapshot.isLearnMode ? 'Nuovo percorso AI' : 'Nuovo progetto';
};

export const buildCoverLabel = (
  snapshot: Pick<ProjectSnapshot, 'source' | 'learningPlan' | 'isLearnMode'>,
  sourceKind: ProjectSourceKind
): string => {
  if (snapshot.source?.kind === 'pdf') {
    return snapshot.source.file.name;
  }

  if (snapshot.source?.kind === 'codebase-bundle') {
    if (sourceKind === 'document') {
      return snapshot.source.name;
    }

    return snapshot.source.files.length > 0
      ? `${snapshot.source.files.length} file`
      : snapshot.source.name;
  }

  if (sourceKind === 'learn-mode') {
    return 'Percorso AI';
  }

  return snapshot.learningPlan?.sections.length ? `${snapshot.learningPlan.sections.length} lezioni` : 'Bozza locale';
};

export const buildProjectMeta = (
  snapshot: ProjectSnapshot,
  previousMeta?: SavedProjectMeta | null,
  options?: { imported?: boolean; touchedAt?: string }
): SavedProjectMeta => {
  const now = options?.touchedAt || new Date().toISOString();
  const sourceKind = snapshot.sourceKind || inferProjectSourceKind(snapshot, options?.imported ?? false);
  const lessonCount = snapshot.learningPlan?.sections.length || 0;
  const completedCount = snapshot.learningPlan?.sections.filter(section => section.isCompleted).length || 0;

  return {
    id: snapshot.id,
    title: getProjectTitle(snapshot),
    sourceKind,
    createdAt: previousMeta?.createdAt || now,
    updatedAt: now,
    lastOpenedAt: previousMeta?.lastOpenedAt || now,
    lessonCount,
    completedCount,
    hasSourceFile: Boolean(snapshot.source),
    coverLabel: buildCoverLabel(snapshot, sourceKind),
    syncState: previousMeta?.syncState || 'local-only',
  };
};

export const createProjectSnapshot = (
  partial: Partial<ProjectSnapshot> & Pick<ProjectSnapshot, 'id'>
): ProjectSnapshot => ({
  id: partial.id,
  version: partial.version || CURRENT_PROJECT_VERSION,
  sourceKind:
    partial.sourceKind ||
    inferProjectSourceKind({ source: partial.source || null, isLearnMode: partial.isLearnMode || false }),
  state: partial.state || AppState.LIBRARY,
  source: partial.source || null,
  learningPlan: partial.learningPlan || null,
  isLearnMode: partial.isLearnMode || false,
  userProfile: partial.userProfile || null,
  syllabus: partial.syllabus || [],
  activeSectionId: partial.activeSectionId || null,
  createdAt: partial.createdAt || new Date().toISOString(),
  updatedAt: partial.updatedAt || new Date().toISOString(),
  lastOpenedAt: partial.lastOpenedAt || new Date().toISOString(),
  documentAssets: partial.documentAssets ?? null,
  documentIndex: partial.documentIndex ?? null,
});

const parseFileData = (value: unknown): FileData | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (!isString(value.name) || !isString(value.mimeType) || !isString(value.data)) {
    return null;
  }

  return {
    name: value.name,
    mimeType: value.mimeType,
    data: value.data,
  };
};

const parseCodebaseBundleSource = (value: Record<string, unknown>): CodebaseBundleSource | null => {
  if (!isString(value.name) || !isString(value.aggregatedText) || !Array.isArray(value.files)) {
    return null;
  }

  return {
    kind: 'codebase-bundle',
    name: value.name,
    aggregatedText: value.aggregatedText,
    files: value.files
      .filter(isRecord)
      .map(file => ({
        path: ensureString(file.path),
        text: ensureString(file.text),
        truncated: typeof file.truncated === 'boolean' ? file.truncated : undefined,
      }))
      .filter(file => file.path && file.text),
    stats: {
      includedFileCount:
        isRecord(value.stats) && typeof value.stats.includedFileCount === 'number'
          ? value.stats.includedFileCount
          : 0,
      skippedFileCount:
        isRecord(value.stats) && typeof value.stats.skippedFileCount === 'number'
          ? value.stats.skippedFileCount
          : 0,
      truncatedFileCount:
        isRecord(value.stats) && typeof value.stats.truncatedFileCount === 'number'
          ? value.stats.truncatedFileCount
          : 0,
      totalCharacterCount:
        isRecord(value.stats) && typeof value.stats.totalCharacterCount === 'number'
          ? value.stats.totalCharacterCount
          : value.aggregatedText.length,
    },
  };
};

const parseProjectSource = (value: unknown): ProjectSource | null => {
  if (!isRecord(value) || !isString(value.kind)) {
    return null;
  }

  if (value.kind === 'pdf') {
    const file = parseFileData(value.file);
    return file && isPdfFileData(file) ? { kind: 'pdf', file } : null;
  }

  if (value.kind === 'codebase-bundle') {
    return parseCodebaseBundleSource(value);
  }

  return null;
};

const parseLearningPlan = (value: unknown): LearningPlan | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (!Array.isArray(value.sections)) {
    return null;
  }

  return {
    title: ensureString(value.title, 'Percorso'),
    summary: ensureString(value.summary),
    sections: value.sections as LearningPlan['sections'],
    backgroundMusicUrl: ensureString(value.backgroundMusicUrl),
  };
};

const parseDocumentAssets = (value: unknown): PdfDocumentAssets | null => {
  if (!isRecord(value) || value.kind !== 'pdf' || !Array.isArray(value.usedImages)) {
    return null;
  }

  return {
    kind: 'pdf',
    parsedAt: ensureString(value.parsedAt, new Date().toISOString()),
    imageCount: typeof value.imageCount === 'number' ? value.imageCount : value.usedImages.length,
    sourceHash: ensureString(value.sourceHash),
    usedImages: value.usedImages
      .filter(isRecord)
      .map(image => ({
        id: ensureString(image.id),
        mimeType: ensureString(image.mimeType, 'image/png'),
        dataUrl: ensureString(image.dataUrl),
        caption: ensureString(image.caption) || undefined,
        textBefore: ensureString(image.textBefore),
        textCurrent: ensureString(image.textCurrent),
        textAfter: ensureString(image.textAfter),
        sourceOrder: typeof image.sourceOrder === 'number' ? image.sourceOrder : 0,
        pageNumber: typeof image.pageNumber === 'number' ? image.pageNumber : undefined,
      }))
      .filter(image => image.id && image.dataUrl),
  };
};

const parseDocumentIndex = (value: unknown): PdfTextIndex | null => {
  if (!isRecord(value) || value.kind !== 'pdf-text-index' || !Array.isArray(value.chunks)) {
    return null;
  }

  return {
    kind: 'pdf-text-index',
    parsedAt: ensureString(value.parsedAt, new Date().toISOString()),
    sourceHash: ensureString(value.sourceHash),
    documentTitle: ensureString(value.documentTitle),
    pageCount: typeof value.pageCount === 'number' ? value.pageCount : undefined,
    chunks: value.chunks
      .filter(isRecord)
      .map(chunk => ({
        id: ensureString(chunk.id),
        text: ensureString(chunk.text),
        headingPath: Array.isArray(chunk.headingPath) ? chunk.headingPath.map(item => ensureString(item)).filter(Boolean) : [],
        sequence: typeof chunk.sequence === 'number' ? chunk.sequence : 0,
        startOffset: typeof chunk.startOffset === 'number' ? chunk.startOffset : 0,
        endOffset: typeof chunk.endOffset === 'number' ? chunk.endOffset : 0,
        pageStart: typeof chunk.pageStart === 'number' ? chunk.pageStart : undefined,
        pageEnd: typeof chunk.pageEnd === 'number' ? chunk.pageEnd : undefined,
      }))
      .filter(chunk => chunk.id && chunk.text),
  };
};

const parseUserProfile = (value: unknown): UserProfile | null => {
  if (!isRecord(value)) {
    return null;
  }

  return {
    topic: ensureString(value.topic),
    experienceLevel: ensureString(value.experienceLevel),
    learningStyle: ensureString(value.learningStyle),
    goals: ensureString(value.goals),
    context: ensureString(value.context),
    language: ensureString(value.language, 'Italiano'),
  };
};

const parseSyllabus = (value: unknown): SyllabusItem[] => (Array.isArray(value) ? (value as SyllabusItem[]) : []);

const parseExplicitSourceKind = (value: unknown): ProjectSourceKind | undefined =>
  value === 'document' || value === 'codebase' || value === 'learn-mode' || value === 'imported-json'
    ? value
    : undefined;

const normalizeProjectRecord = (data: unknown, imported: boolean): ProjectSnapshot => {
  const nextId = createProjectId();
  const now = new Date().toISOString();

  if (!isRecord(data)) {
    return createProjectSnapshot({ id: nextId });
  }

  const learningPlan = parseLearningPlan(data.learningPlan ?? data);
  const syllabus = parseSyllabus(data.syllabus);
  const source = parseProjectSource(data.source);
  const legacyFile = parseFileData(data.file);
  const fallbackSource = source || (legacyFile ? createProjectSourceFromFile(legacyFile) : null);
  const hasParentSections = learningPlan?.sections.some(section => Boolean(section.parentId)) || false;
  const isLearnMode = typeof data.isLearnMode === 'boolean' ? data.isLearnMode : syllabus.length > 0 || hasParentSections;
  const explicitSourceKind = parseExplicitSourceKind(data.sourceKind);

  return createProjectSnapshot({
    id: isString(data.id) ? data.id : nextId,
    version: ensureString(data.version, CURRENT_PROJECT_VERSION),
    state: learningPlan ? AppState.READING : AppState.LIBRARY,
    sourceKind: explicitSourceKind || inferProjectSourceKind({ source: fallbackSource, isLearnMode }, imported),
    source: fallbackSource,
    learningPlan:
      learningPlan && !learningPlan.backgroundMusicUrl && isString(data.musicUrl)
        ? { ...learningPlan, backgroundMusicUrl: ensureString(data.musicUrl) }
        : learningPlan,
    isLearnMode,
    userProfile: parseUserProfile(data.userProfile),
    syllabus,
    activeSectionId: ensureString(data.activeSectionId) || null,
    createdAt: ensureString(data.createdAt, now),
    updatedAt: ensureString(data.updatedAt, now),
    lastOpenedAt: ensureString(data.lastOpenedAt, now),
    documentAssets: parseDocumentAssets(data.documentAssets),
    documentIndex: parseDocumentIndex(data.documentIndex),
  });
};

export const normalizeStoredProject = (data: unknown): ProjectSnapshot =>
  normalizeProjectRecord(data, false);

export const normalizeImportedProject = (data: unknown): ProjectSnapshot =>
  normalizeProjectRecord(data, true);

export const exportProjectData = (snapshot: ProjectSnapshot): ProjectExportData => ({
  id: snapshot.id,
  version: snapshot.version,
  state: snapshot.state,
  file: getProjectSourceFile(snapshot.source),
  source: snapshot.source,
  learningPlan: snapshot.learningPlan,
  isLearnMode: snapshot.isLearnMode,
  userProfile: snapshot.userProfile,
  syllabus: snapshot.syllabus,
  activeSectionId: snapshot.activeSectionId,
  musicUrl: snapshot.learningPlan?.backgroundMusicUrl || '',
  sourceKind: snapshot.sourceKind,
  documentAssets: snapshot.documentAssets ?? null,
  documentIndex: snapshot.documentIndex ?? null,
});
