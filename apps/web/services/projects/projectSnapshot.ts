import {
  AppState,
  type CodebaseBundleSource,
  type CourseSourceDescriptor,
  type FileData,
  type LearningPlan,
  type PdfDocumentAssets,
  type PdfTextIndex,
  type ProjectExportData,
  type ProjectId,
  type ProjectSnapshot,
  type ProjectSource,
  type ProjectSourceKind,
  type ProjectSourceRef,
  type SavedProjectMeta,
  type SourceOutlineNode,
  type SyllabusItem,
  type UserProfile,
} from '../../types.ts';
import { createEntityId } from '../../utils/ids.ts';
import { flattenLessons, flattenPathNodes } from '../../utils/learning/pathNodes.ts';
import { isRecord } from '../../utils/records.ts';
import { timestampIso } from '../../utils/time.ts';
import { normalizeYouTubeClipInterval } from '../../utils/youtube.ts';
import { groupSectionsIntoModules } from '../learning/groupSectionsIntoModules.ts';
import { normalizeCourseSourceOrder } from './courseSources.ts';
import {
  createProjectSourceFromFile,
  getProjectSourceName,
  isDocumentProjectSource,
  isPdfFileData,
} from './projectSource.ts';

const CURRENT_PROJECT_VERSION = '4.1';

const isString = (value: unknown): value is string => typeof value === 'string';

const ensureString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

export const createProjectId = (): ProjectId => createEntityId({ fallbackPrefix: 'project' });

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

const getProjectTitle = (
  snapshot: Pick<
    ProjectSnapshot,
    'title' | 'learningPlan' | 'source' | 'userProfile' | 'isLearnMode'
  >
): string => {
  const explicitTitle = snapshot.title?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

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

  const lessonCount = snapshot.learningPlan
    ? flattenLessons(snapshot.learningPlan.modules).length
    : 0;
  return lessonCount > 0 ? `${lessonCount} lezioni` : 'Bozza salvata';
};

export const buildProjectMeta = (
  snapshot: ProjectSnapshot,
  previousMeta?: SavedProjectMeta | null,
  options?: { imported?: boolean; touchedAt?: string }
): SavedProjectMeta => {
  const now = options?.touchedAt || timestampIso();
  const sourceKind =
    snapshot.sourceKind || inferProjectSourceKind(snapshot, options?.imported ?? false);
  const lessons = snapshot.learningPlan ? flattenLessons(snapshot.learningPlan.modules) : [];
  const exercises = snapshot.learningPlan
    ? flattenPathNodes(snapshot.learningPlan.modules).filter(node => node.kind === 'exercise')
    : [];

  return {
    id: snapshot.id,
    title: getProjectTitle(snapshot),
    sourceKind,
    createdAt: previousMeta?.createdAt || now,
    updatedAt: now,
    lastOpenedAt: previousMeta?.lastOpenedAt || now,
    lessonCount: lessons.length,
    completedCount: lessons.filter(lesson => lesson.isCompleted).length,
    exerciseCount: exercises.length,
    completedExercises: exercises.filter(exercise => exercise.isCompleted).length,
    hasSourceFile: Boolean(snapshot.source),
    coverLabel: buildCoverLabel(snapshot, sourceKind),
  };
};

export const createProjectSnapshot = (
  partial: Partial<ProjectSnapshot> & Pick<ProjectSnapshot, 'id'>
): ProjectSnapshot => {
  const title = partial.title?.trim() || undefined;
  const learningPlan = partial.learningPlan
    ? title
      ? { ...partial.learningPlan, title }
      : partial.learningPlan
    : null;

  return {
    id: partial.id,
    version: partial.version || CURRENT_PROJECT_VERSION,
    ...(title ? { title } : {}),
    sourceKind:
      partial.sourceKind ||
      inferProjectSourceKind({
        source: partial.source || null,
        isLearnMode: partial.isLearnMode || false,
      }),
    state: partial.state || AppState.LIBRARY,
    source: partial.source || null,
    learningPlan,
    isLearnMode: partial.isLearnMode || false,
    userProfile: partial.userProfile || null,
    syllabus: partial.syllabus || [],
    researchCoursePlan: partial.researchCoursePlan ?? null,
    researchDossiersBySectionId: partial.researchDossiersBySectionId ?? {},
    activeSectionId: partial.activeSectionId || null,
    createdAt: partial.createdAt || timestampIso(),
    updatedAt: partial.updatedAt || timestampIso(),
    lastOpenedAt: partial.lastOpenedAt || timestampIso(),
    documentAssets: partial.documentAssets ?? null,
    documentIndex: partial.documentIndex ?? null,
  };
};

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
    ...(isString(value.sourceId) ? { sourceId: value.sourceId } : {}),
  };
};

const parseProjectSourceRef = (value: unknown): ProjectSourceRef | undefined => {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.hash) ||
    typeof value.byteSize !== 'number' ||
    !isString(value.name) ||
    !isString(value.mimeType)
  ) {
    return undefined;
  }

  return {
    id: value.id,
    hash: value.hash,
    byteSize: value.byteSize,
    name: value.name,
    mimeType: value.mimeType,
  };
};

const parseSourceOutlineNodes = (value: unknown): SourceOutlineNode[] =>
  Array.isArray(value)
    ? value
        .filter(isRecord)
        .map(node => ({
          children: parseSourceOutlineNodes(node.children),
          endOffset: typeof node.endOffset === 'number' ? node.endOffset : undefined,
          id: ensureString(node.id),
          level: typeof node.level === 'number' ? node.level : 1,
          page: typeof node.page === 'number' ? node.page : undefined,
          startOffset: typeof node.startOffset === 'number' ? node.startOffset : undefined,
          title: ensureString(node.title),
        }))
        .filter(node => node.id && node.title)
    : [];

const parseCourseSources = (value: unknown): CourseSourceDescriptor[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const sources = value
    .filter(isRecord)
    .map(source => {
      const file = parseFileData(source.file);
      const kind =
        source.kind === 'pdf' || source.kind === 'markdown' || source.kind === 'text'
          ? source.kind
          : null;
      if (
        !file ||
        !kind ||
        !isString(source.id) ||
        !isString(source.hash) ||
        !isString(source.name)
      ) {
        return null;
      }
      return {
        documentIndex: parseDocumentIndex(source.documentIndex),
        errorMessage: ensureString(source.errorMessage) || undefined,
        file: { ...file, sourceId: file.sourceId || source.id },
        hash: source.hash,
        id: source.id,
        kind,
        name: source.name,
        outline: parseSourceOutlineNodes(source.outline),
        outlineOrigin:
          source.outlineOrigin === 'native' || source.outlineOrigin === 'deterministic'
            ? source.outlineOrigin
            : 'none',
        position: typeof source.position === 'number' ? source.position : 0,
        status: source.status === 'error' || source.status === 'partial' ? source.status : 'ready',
      } satisfies CourseSourceDescriptor;
    })
    .filter((source): source is Exclude<typeof source, null> => source !== null);

  return sources.length > 0 ? normalizeCourseSourceOrder(sources) : undefined;
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
    sources: parseCourseSources(value.sources),
  };
};

const parseProjectSource = (value: unknown): ProjectSource | null => {
  if (!isRecord(value) || !isString(value.kind)) {
    return null;
  }

  if (value.kind === 'pdf') {
    const file = parseFileData(value.file);
    return file && isPdfFileData(file)
      ? {
          kind: 'pdf',
          file,
          ref: parseProjectSourceRef(value.ref),
          sources: parseCourseSources(value.sources),
        }
      : null;
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

  // Already in the new module-shaped form.
  if (Array.isArray(value.modules)) {
    return {
      title: ensureString(value.title, 'Percorso'),
      summary: ensureString(value.summary),
      modules: value.modules as LearningPlan['modules'],
      applicationExercisePlanningStatus:
        (value.applicationExercisePlanningStatus as LearningPlan['applicationExercisePlanningStatus']) ??
        'not-run',
      applicationExercisePlanningNotes:
        ensureString(value.applicationExercisePlanningNotes) || undefined,
      applicationExercisePlanningError:
        (value.applicationExercisePlanningError as LearningPlan['applicationExercisePlanningError']) ??
        undefined,
      backgroundMusicUrl: ensureString(value.backgroundMusicUrl) || undefined,
      generationNotes: ensureString(value.generationNotes) || undefined,
    };
  }

  // Legacy: sections-shaped plan. Group on the way in.
  if (Array.isArray(value.sections)) {
    return {
      title: ensureString(value.title, 'Percorso'),
      summary: ensureString(value.summary),
      modules: groupSectionsIntoModules(
        value.sections as Parameters<typeof groupSectionsIntoModules>[0]
      ),
      applicationExercisePlanningStatus: 'not-run',
      backgroundMusicUrl: ensureString(value.backgroundMusicUrl) || undefined,
      generationNotes: ensureString(value.generationNotes) || undefined,
    };
  }

  return null;
};

const parseDocumentAssets = (value: unknown): PdfDocumentAssets | null => {
  if (!isRecord(value) || value.kind !== 'pdf' || !Array.isArray(value.usedImages)) {
    return null;
  }

  return {
    kind: 'pdf',
    parsedAt: ensureString(value.parsedAt, timestampIso()),
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

function parseDocumentIndex(value: unknown): PdfTextIndex | null {
  if (!isRecord(value) || value.kind !== 'pdf-text-index' || !Array.isArray(value.chunks)) {
    return null;
  }

  return {
    kind: 'pdf-text-index',
    parsedAt: ensureString(value.parsedAt, timestampIso()),
    sourceHash: ensureString(value.sourceHash),
    sourceIds: Array.isArray(value.sourceIds)
      ? value.sourceIds.map(sourceId => ensureString(sourceId)).filter(Boolean)
      : undefined,
    documentTitle: ensureString(value.documentTitle),
    pageCount: typeof value.pageCount === 'number' ? value.pageCount : undefined,
    chunks: value.chunks
      .filter(isRecord)
      .map(chunk => ({
        id: ensureString(chunk.id),
        text: ensureString(chunk.text),
        headingPath: Array.isArray(chunk.headingPath)
          ? chunk.headingPath.map(item => ensureString(item)).filter(Boolean)
          : [],
        sequence: typeof chunk.sequence === 'number' ? chunk.sequence : 0,
        startOffset: typeof chunk.startOffset === 'number' ? chunk.startOffset : 0,
        endOffset: typeof chunk.endOffset === 'number' ? chunk.endOffset : 0,
        pageStart: typeof chunk.pageStart === 'number' ? chunk.pageStart : undefined,
        pageEnd: typeof chunk.pageEnd === 'number' ? chunk.pageEnd : undefined,
        sourceId: ensureString(chunk.sourceId) || undefined,
      }))
      .filter(chunk => chunk.id && chunk.text),
    mappingQuality: isRecord(value.mappingQuality)
      ? {
          coverageRatio:
            typeof value.mappingQuality.coverageRatio === 'number'
              ? value.mappingQuality.coverageRatio
              : undefined,
          gapCount:
            typeof value.mappingQuality.gapCount === 'number'
              ? value.mappingQuality.gapCount
              : undefined,
          lessonCount:
            typeof value.mappingQuality.lessonCount === 'number'
              ? value.mappingQuality.lessonCount
              : undefined,
          mappedLessonCount:
            typeof value.mappingQuality.mappedLessonCount === 'number'
              ? value.mappingQuality.mappedLessonCount
              : undefined,
          mappingSource: value.mappingQuality.mappingSource === 'mapped' ? 'mapped' : 'fallback',
          updatedAt: ensureString(value.mappingQuality.updatedAt, timestampIso()),
        }
      : undefined,
    mappingRecovery:
      isRecord(value.mappingRecovery) && value.mappingRecovery.status === 'exhausted'
        ? {
            status: 'exhausted',
            updatedAt: ensureString(value.mappingRecovery.updatedAt, timestampIso()),
          }
        : undefined,
    mappingWarnings: Array.isArray(value.mappingWarnings)
      ? value.mappingWarnings.map(warning => ensureString(warning)).filter(Boolean)
      : undefined,
  };
}

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

const parseSyllabus = (value: unknown): SyllabusItem[] =>
  Array.isArray(value) ? (value as SyllabusItem[]) : [];

const parseStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(item => ensureString(item)).filter(Boolean) : [];

const parseResearchVideoClip = (source: Record<string, unknown>, url: string | undefined) => {
  if (!isRecord(source.videoClip) || !url) {
    return undefined;
  }
  return (
    normalizeYouTubeClipInterval(url, source.videoClip.startSeconds, source.videoClip.endSeconds) ||
    undefined
  );
};

const parseResearchSourceReferences = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter(isRecord)
        .map(source => {
          const url = ensureString(source.url) || undefined;
          const videoClip = parseResearchVideoClip(source, url);
          return {
            title: ensureString(source.title),
            url,
            note: ensureString(source.note) || undefined,
            ...(videoClip ? { videoClip } : {}),
          };
        })
        .filter(source => source.title || source.url)
    : [];

const parseResearchCoursePlan = (value: unknown): ProjectSnapshot['researchCoursePlan'] => {
  if (!isRecord(value) || !Array.isArray(value.lessons)) {
    return null;
  }

  const now = timestampIso();

  return {
    generatedAt: ensureString(value.generatedAt, now),
    lessonCountReason: ensureString(value.lessonCountReason),
    title: ensureString(value.title, 'Percorso di ricerca'),
    summary: ensureString(value.summary),
    lessons: value.lessons
      .filter(isRecord)
      .map(lesson => ({
        id: ensureString(lesson.id),
        title: ensureString(lesson.title),
        description: ensureString(lesson.description),
        moduleId: ensureString(lesson.moduleId),
        moduleTitle: ensureString(lesson.moduleTitle),
        prerequisites: parseStringArray(lesson.prerequisites),
        keyConcepts: parseStringArray(lesson.keyConcepts),
        guidingQuestions: parseStringArray(lesson.guidingQuestions),
        miniLab: ensureString(lesson.miniLab),
        simplificationRisks: parseStringArray(lesson.simplificationRisks),
        sourceHints: parseResearchSourceReferences(lesson.sourceHints),
      }))
      .filter(lesson => lesson.id && lesson.title),
  };
};

const parseResearchDossiers = (value: unknown): ProjectSnapshot['researchDossiersBySectionId'] => {
  if (!isRecord(value)) {
    return {};
  }

  const now = timestampIso();
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([sectionId, dossier]) => [
        sectionId,
        {
          sectionId: ensureString(dossier.sectionId, sectionId),
          title: ensureString(dossier.title),
          generatedAt: ensureString(dossier.generatedAt, now),
          factualSummary: ensureString(dossier.factualSummary),
          keyExamples: parseStringArray(dossier.keyExamples),
          difficultSteps: parseStringArray(dossier.difficultSteps),
          recentDevelopments: parseStringArray(dossier.recentDevelopments),
          avoidOversimplifying: parseStringArray(dossier.avoidOversimplifying),
          controversies: parseStringArray(dossier.controversies),
          sources: parseResearchSourceReferences(dossier.sources),
        },
      ])
  );
};

const parseExplicitSourceKind = (value: unknown): ProjectSourceKind | undefined =>
  value === 'document' ||
  value === 'codebase' ||
  value === 'learn-mode' ||
  value === 'imported-json'
    ? value
    : undefined;

const normalizeProjectRecord = (data: unknown, imported: boolean): ProjectSnapshot => {
  const nextId = createProjectId();
  const now = timestampIso();

  if (!isRecord(data)) {
    return createProjectSnapshot({ id: nextId });
  }

  const learningPlan = parseLearningPlan(data.learningPlan ?? data);
  const syllabus = parseSyllabus(data.syllabus);
  const source = parseProjectSource(data.source);
  const legacyFile = parseFileData(data.file);
  const fallbackSource = source || (legacyFile ? createProjectSourceFromFile(legacyFile) : null);
  const hasParentLessons = learningPlan
    ? flattenLessons(learningPlan.modules).some(lesson => Boolean(lesson.parentId))
    : false;
  const isLearnMode =
    typeof data.isLearnMode === 'boolean'
      ? data.isLearnMode
      : syllabus.length > 0 || hasParentLessons;
  const explicitSourceKind = parseExplicitSourceKind(data.sourceKind);

  return createProjectSnapshot({
    id: isString(data.id) ? data.id : nextId,
    version: ensureString(data.version, CURRENT_PROJECT_VERSION),
    title: ensureString(data.title) || undefined,
    state: learningPlan ? AppState.READING : AppState.LIBRARY,
    sourceKind:
      explicitSourceKind ||
      inferProjectSourceKind({ source: fallbackSource, isLearnMode }, imported),
    source: fallbackSource,
    learningPlan:
      learningPlan && !learningPlan.backgroundMusicUrl && isString(data.musicUrl)
        ? { ...learningPlan, backgroundMusicUrl: ensureString(data.musicUrl) }
        : learningPlan,
    isLearnMode,
    userProfile: parseUserProfile(data.userProfile),
    syllabus,
    researchCoursePlan: parseResearchCoursePlan(data.researchCoursePlan),
    researchDossiersBySectionId: parseResearchDossiers(data.researchDossiersBySectionId),
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
  title: snapshot.title,
  state: snapshot.state,
  source: snapshot.source,
  learningPlan: snapshot.learningPlan,
  isLearnMode: snapshot.isLearnMode,
  userProfile: snapshot.userProfile,
  syllabus: snapshot.syllabus,
  researchCoursePlan: snapshot.researchCoursePlan ?? null,
  researchDossiersBySectionId: snapshot.researchDossiersBySectionId ?? {},
  activeSectionId: snapshot.activeSectionId,
  musicUrl: snapshot.learningPlan?.backgroundMusicUrl || '',
  sourceKind: snapshot.sourceKind,
  documentAssets: snapshot.documentAssets ?? null,
  documentIndex: snapshot.documentIndex ?? null,
});
