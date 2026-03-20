import { AppState, type FileData, type LearningPlan, type PdfDocumentAssets, type PdfTextIndex, type ProjectExportData, type ProjectId, type ProjectSnapshot, type ProjectSourceKind, type SavedProjectMeta, type SyllabusItem, type UserProfile } from '../types';

const CURRENT_PROJECT_VERSION = '3.2';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isString = (value: unknown): value is string => typeof value === 'string';

const ensureString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

export const createProjectId = (): ProjectId => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `project-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

export const inferProjectSourceKind = (snapshot: Pick<ProjectSnapshot, 'file' | 'isLearnMode'>, imported = false): ProjectSourceKind => {
  if (snapshot.isLearnMode) {
    return 'learn-mode';
  }

  if (snapshot.file?.mimeType === 'application/zip' || snapshot.file?.name.toLowerCase().endsWith('.zip')) {
    return 'codebase';
  }

  if (snapshot.file) {
    return 'document';
  }

  return imported ? 'imported-json' : 'document';
};

export const getProjectTitle = (snapshot: Pick<ProjectSnapshot, 'learningPlan' | 'file' | 'userProfile' | 'isLearnMode'>): string => {
  const planTitle = snapshot.learningPlan?.title?.trim();
  if (planTitle) {
    return planTitle;
  }

  const userTopic = snapshot.userProfile?.topic?.trim();
  if (userTopic) {
    return userTopic;
  }

  const fileName = snapshot.file?.name?.trim();
  if (fileName) {
    return fileName;
  }

  return snapshot.isLearnMode ? 'Nuovo percorso AI' : 'Nuovo progetto';
};

export const buildCoverLabel = (snapshot: Pick<ProjectSnapshot, 'file' | 'learningPlan' | 'isLearnMode'>, sourceKind: ProjectSourceKind): string => {
  if (snapshot.file?.name) {
    return snapshot.file.name;
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
    hasSourceFile: Boolean(snapshot.file),
    coverLabel: buildCoverLabel(snapshot, sourceKind),
    syncState: previousMeta?.syncState || 'local-only',
  };
};

export const createProjectSnapshot = (
  partial: Partial<ProjectSnapshot> & Pick<ProjectSnapshot, 'id'>
): ProjectSnapshot => ({
  id: partial.id,
  version: partial.version || CURRENT_PROJECT_VERSION,
  sourceKind: partial.sourceKind || inferProjectSourceKind({ file: partial.file || null, isLearnMode: partial.isLearnMode || false }),
  state: partial.state || AppState.LIBRARY,
  file: partial.file || null,
  learningPlan: partial.learningPlan || null,
  isLearnMode: partial.isLearnMode || false,
  userProfile: partial.userProfile || null,
  syllabus: partial.syllabus || [],
  activeSectionId: partial.activeSectionId || null,
  musicUrl: partial.musicUrl || partial.learningPlan?.backgroundMusicUrl || '',
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
        textBefore: ensureString(image.textBefore),
        textAfter: ensureString(image.textAfter),
        sourceOrder: typeof image.sourceOrder === 'number' ? image.sourceOrder : 0,
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
    chunks: value.chunks
      .filter(isRecord)
      .map(chunk => ({
        id: ensureString(chunk.id),
        text: ensureString(chunk.text),
        headingPath: Array.isArray(chunk.headingPath) ? chunk.headingPath.map(item => ensureString(item)).filter(Boolean) : [],
        sequence: typeof chunk.sequence === 'number' ? chunk.sequence : 0,
        startOffset: typeof chunk.startOffset === 'number' ? chunk.startOffset : 0,
        endOffset: typeof chunk.endOffset === 'number' ? chunk.endOffset : 0,
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

export const normalizeImportedProject = (data: unknown): ProjectSnapshot => {
  const nextId = createProjectId();
  const now = new Date().toISOString();

  if (!isRecord(data)) {
    return createProjectSnapshot({ id: nextId });
  }

  const learningPlan = parseLearningPlan(data.learningPlan ?? data);
  const syllabus = parseSyllabus(data.syllabus);
  const file = parseFileData(data.file);
  const hasParentSections = learningPlan?.sections.some(section => Boolean(section.parentId)) || false;
  const isLearnMode = typeof data.isLearnMode === 'boolean' ? data.isLearnMode : syllabus.length > 0 || hasParentSections;
  const explicitSourceKind =
    data.sourceKind === 'document' ||
    data.sourceKind === 'codebase' ||
    data.sourceKind === 'learn-mode' ||
    data.sourceKind === 'imported-json'
      ? data.sourceKind
      : undefined;

  return createProjectSnapshot({
    id: isString(data.id) ? data.id : nextId,
    version: ensureString(data.version, CURRENT_PROJECT_VERSION),
    state: learningPlan ? AppState.READING : AppState.LIBRARY,
    sourceKind: explicitSourceKind || inferProjectSourceKind({ file, isLearnMode }, true),
    file,
    learningPlan,
    isLearnMode,
    userProfile: parseUserProfile(data.userProfile),
    syllabus,
    activeSectionId: ensureString(data.activeSectionId) || null,
    musicUrl: ensureString(data.musicUrl || learningPlan?.backgroundMusicUrl),
    createdAt: ensureString(data.createdAt, now),
    updatedAt: ensureString(data.updatedAt, now),
    lastOpenedAt: ensureString(data.lastOpenedAt, now),
    documentAssets: parseDocumentAssets(data.documentAssets),
    documentIndex: parseDocumentIndex(data.documentIndex),
  });
};

export const exportProjectData = (snapshot: ProjectSnapshot): ProjectExportData => ({
  id: snapshot.id,
  version: snapshot.version,
  state: snapshot.state,
  file: snapshot.file,
  learningPlan: snapshot.learningPlan,
  isLearnMode: snapshot.isLearnMode,
  userProfile: snapshot.userProfile,
  syllabus: snapshot.syllabus,
  activeSectionId: snapshot.activeSectionId,
  musicUrl: snapshot.musicUrl || snapshot.learningPlan?.backgroundMusicUrl || '',
  sourceKind: snapshot.sourceKind,
  documentAssets: snapshot.documentAssets ?? null,
  documentIndex: snapshot.documentIndex ?? null,
});
