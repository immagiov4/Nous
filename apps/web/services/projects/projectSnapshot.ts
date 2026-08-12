import {
  decodeProjectSnapshotWire,
  encodeProjectSnapshotWire,
  type ProjectSnapshotWire,
  type ProjectSnapshotWireDecodeOptions,
} from '@shared/projectSnapshotWire';
import { parseYouTubeTranscript } from '@shared/youtubeTranscript';
import {
  AppState,
  type CourseSourceDescriptor,
  type FileData,
  type LearningPlan,
  type PdfDocumentAssets,
  type PdfDocumentImageAsset,
  type PdfTextIndex,
  type ProjectId,
  type ProjectSnapshot,
  type ProjectSource,
  type ProjectSourceKind,
  type ProjectSourceRef,
  type SavedProjectMeta,
  type SourceArchiveIndex,
  type SourceOutlineNode,
  type SyllabusItem,
  type UserProfile,
} from '../../types.ts';
import { createEntityId } from '../../utils/ids.ts';
import { normalizeLessonInstructionPacks } from '../../utils/learning/lessonInstructionPacks.ts';
import { flattenLessons, flattenPathNodes } from '../../utils/learning/pathNodes.ts';
import { isRecord } from '../../utils/records.ts';
import { timestampIso } from '../../utils/time.ts';
import { normalizeYouTubeClipInterval } from '../../utils/youtube.ts';
import { groupSectionsIntoModules } from '../learning/groupSectionsIntoModules.ts';
import { normalizeCourseSourceOrder } from './courseSources.ts';
import { getProjectSourceName, isDocumentProjectSource, isPdfFileData } from './projectSource.ts';

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

  if (snapshot.source?.kind === 'archive') {
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
  if (snapshot.source?.kind === 'pdf' || snapshot.source?.kind === 'document') {
    return snapshot.source.file.name;
  }

  if (snapshot.source?.kind === 'archive') {
    const fileCount = snapshot.source.index.entries.filter(entry => entry.kind === 'file').length;
    return fileCount > 0 ? `${fileCount} file` : snapshot.source.name;
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
    lastCourseGenerationRunId: partial.lastCourseGenerationRunId ?? null,
    activeSectionId: partial.activeSectionId || null,
    createdAt: partial.createdAt || timestampIso(),
    updatedAt: partial.updatedAt || timestampIso(),
    lastOpenedAt: partial.lastOpenedAt || timestampIso(),
    ...(partial.legacyUnmappedFields ? { legacyUnmappedFields: partial.legacyUnmappedFields } : {}),
    documentAssets: partial.documentAssets ?? null,
    documentIndex: partial.documentIndex ?? null,
    ...(partial.extensions ? { extensions: partial.extensions } : {}),
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
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 0 ||
    !isString(value.name) ||
    !isString(value.mimeType) ||
    !isString(value.objectPath)
  ) {
    return undefined;
  }

  return {
    id: value.id,
    hash: value.hash,
    byteSize: value.byteSize,
    name: value.name,
    mimeType: value.mimeType,
    objectPath: value.objectPath,
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
      const ref = parseProjectSourceRef(source.ref);
      const kind =
        source.kind === 'pdf' || source.kind === 'markdown' || source.kind === 'text'
          ? source.kind
          : null;
      if (
        !file ||
        !kind ||
        !isString(source.id) ||
        !isString(source.hash) ||
        !isString(source.name) ||
        (!file.data && !ref)
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
        ...(ref ? { ref } : {}),
        status: source.status === 'error' || source.status === 'partial' ? source.status : 'ready',
      } satisfies CourseSourceDescriptor;
    })
    .filter((source): source is Exclude<typeof source, null> => source !== null);

  return sources.length === value.length && sources.length > 0
    ? normalizeCourseSourceOrder(sources)
    : undefined;
};

const parseSourceArchiveIndex = (value: unknown): SourceArchiveIndex | null => {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return null;
  }

  const entries = value.entries.map(entry => {
    if (!isRecord(entry) || !isString(entry.path) || !entry.path) {
      return null;
    }
    if (entry.kind === 'directory') {
      return { kind: 'directory' as const, path: entry.path };
    }
    if (
      entry.kind !== 'file' ||
      typeof entry.byteSize !== 'number' ||
      !Number.isSafeInteger(entry.byteSize) ||
      entry.byteSize < 0 ||
      (entry.contentKind !== 'binary' && entry.contentKind !== 'text') ||
      (entry.hash !== undefined && !isString(entry.hash)) ||
      (entry.preview !== undefined && !isString(entry.preview))
    ) {
      return null;
    }
    return {
      byteSize: entry.byteSize,
      contentKind: entry.contentKind,
      ...(isString(entry.hash) ? { hash: entry.hash } : {}),
      kind: 'file' as const,
      path: entry.path,
      ...(isString(entry.preview) ? { preview: entry.preview } : {}),
    };
  });

  if (entries.some(entry => entry === null)) {
    return null;
  }

  return { entries: entries as SourceArchiveIndex['entries'] };
};

const parseProjectSource = (value: unknown): ProjectSource | null => {
  if (!isRecord(value) || !isString(value.kind)) {
    return null;
  }

  const ref = parseProjectSourceRef(value.ref);
  const sources = parseCourseSources(value.sources);
  if (Array.isArray(value.sources) && !sources) {
    return null;
  }

  if (value.kind === 'pdf') {
    const file = parseFileData(value.file);
    return file && isPdfFileData(file) && (file.data || ref)
      ? {
          kind: 'pdf',
          file,
          ...(ref ? { ref } : {}),
          ...(sources ? { sources } : {}),
        }
      : null;
  }

  if (value.kind === 'document') {
    const file = parseFileData(value.file);
    return file && !isPdfFileData(file) && (file.data || ref)
      ? {
          file,
          kind: 'document',
          ...(ref ? { ref } : {}),
          ...(sources ? { sources } : {}),
        }
      : null;
  }

  if (value.kind === 'archive') {
    const file = parseFileData(value.file);
    const index = parseSourceArchiveIndex(value.index);
    return file && index && isString(value.name) && (file.data || ref)
      ? {
          file,
          index,
          kind: 'archive',
          name: value.name,
          ...(ref ? { ref } : {}),
          ...(sources ? { sources } : {}),
        }
      : null;
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
    usedImages: value.usedImages.flatMap((image): PdfDocumentImageAsset[] => {
      if (!isRecord(image)) return [];
      const id = ensureString(image.id);
      const shared = {
        id,
        caption: ensureString(image.caption) || undefined,
        intrinsicHeight:
          typeof image.intrinsicHeight === 'number' ? image.intrinsicHeight : undefined,
        intrinsicWidth: typeof image.intrinsicWidth === 'number' ? image.intrinsicWidth : undefined,
        pageNumber: typeof image.pageNumber === 'number' ? image.pageNumber : undefined,
        sourceOrder: typeof image.sourceOrder === 'number' ? image.sourceOrder : 0,
        textAfter: ensureString(image.textAfter),
        textBefore: ensureString(image.textBefore),
        textCurrent: ensureString(image.textCurrent),
      };
      if (isRecord(image.asset)) {
        const byteSize = image.asset.byteSize;
        const hash = ensureString(image.asset.hash);
        const assetId = ensureString(image.asset.id);
        const mediaType = ensureString(image.asset.mediaType);
        return id &&
          typeof byteSize === 'number' &&
          Number.isSafeInteger(byteSize) &&
          byteSize >= 0 &&
          hash &&
          assetId &&
          mediaType
          ? [{ ...shared, asset: { byteSize, hash, id: assetId, mediaType } }]
          : [];
      }
      const dataUrl = ensureString(image.dataUrl);
      return id && dataUrl
        ? [
            {
              ...shared,
              dataUrl,
              mimeType: ensureString(image.mimeType, 'image/png'),
              sizeBytes: typeof image.sizeBytes === 'number' ? image.sizeBytes : undefined,
            },
          ]
        : [];
    }),
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
          const youtubeTranscript = parseYouTubeTranscript(source.youtubeTranscript) || undefined;
          return {
            title: ensureString(source.title),
            url,
            note: ensureString(source.note) || undefined,
            ...(youtubeTranscript ? { youtubeTranscript } : {}),
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
        ...('instructionPacks' in lesson
          ? { instructionPacks: normalizeLessonInstructionPacks(lesson.instructionPacks) }
          : {}),
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
          ...(isRecord(dossier.youtubeResearch)
            ? {
                youtubeResearch: {
                  rationale: ensureString(dossier.youtubeResearch.rationale),
                  outcome: dossier.youtubeResearch.outcome === 'failed' ? 'failed' : 'completed',
                  candidateDecisions: Array.isArray(dossier.youtubeResearch.candidateDecisions)
                    ? dossier.youtubeResearch.candidateDecisions
                        .filter(isRecord)
                        .flatMap(decision => {
                          const url = ensureString(decision.url);
                          const reason = ensureString(decision.reason);
                          const outcome = ensureString(decision.decision);
                          if (
                            !url ||
                            !reason ||
                            !['rejected', 'selected-source'].includes(outcome)
                          ) {
                            return [];
                          }
                          return [
                            {
                              url,
                              reason,
                              decision: outcome as 'rejected' | 'selected-source',
                            },
                          ];
                        })
                    : [],
                },
              }
            : {}),
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
  const wire = decodeProjectSnapshotWire(data);
  const learningPlan = parseLearningPlan(wire.learningPlan ?? wire);
  const syllabus = parseSyllabus(wire.syllabus);
  const source = parseProjectSource(wire.source);
  const hasParentLessons = learningPlan
    ? flattenLessons(learningPlan.modules).some(lesson => Boolean(lesson.parentId))
    : false;
  const isLearnMode =
    typeof wire.isLearnMode === 'boolean'
      ? wire.isLearnMode
      : syllabus.length > 0 || hasParentLessons;
  const explicitSourceKind = parseExplicitSourceKind(wire.sourceKind);

  return createProjectSnapshot({
    id: isString(wire.id) ? wire.id : nextId,
    version: ensureString(wire.version, CURRENT_PROJECT_VERSION),
    title: ensureString(wire.title) || undefined,
    state: learningPlan ? AppState.READING : AppState.LIBRARY,
    sourceKind: explicitSourceKind || inferProjectSourceKind({ source, isLearnMode }, imported),
    source,
    learningPlan:
      learningPlan && !learningPlan.backgroundMusicUrl && isString(wire.musicUrl)
        ? { ...learningPlan, backgroundMusicUrl: ensureString(wire.musicUrl) }
        : learningPlan,
    isLearnMode,
    userProfile: parseUserProfile(wire.userProfile),
    syllabus,
    researchCoursePlan: parseResearchCoursePlan(wire.researchCoursePlan),
    researchDossiersBySectionId: parseResearchDossiers(wire.researchDossiersBySectionId),
    lastCourseGenerationRunId: wire.lastCourseGenerationRunId ?? null,
    activeSectionId: ensureString(wire.activeSectionId) || null,
    createdAt: ensureString(wire.createdAt, now),
    updatedAt: ensureString(wire.updatedAt, now),
    lastOpenedAt: ensureString(wire.lastOpenedAt, now),
    ...(wire.legacyUnmappedFields ? { legacyUnmappedFields: wire.legacyUnmappedFields } : {}),
    documentAssets: parseDocumentAssets(wire.documentAssets),
    documentIndex: parseDocumentIndex(wire.documentIndex),
    ...(wire.extensions ? { extensions: wire.extensions } : {}),
  });
};

export const normalizeStoredProject = (data: unknown): ProjectSnapshot =>
  normalizeProjectRecord(data, false);

export const normalizeImportedProject = (data: unknown): ProjectSnapshot =>
  normalizeProjectRecord(data, true);

export const exportProjectData = (
  snapshot: ProjectSnapshot,
  options: ProjectSnapshotWireDecodeOptions = {}
): ProjectSnapshotWire => encodeProjectSnapshotWire(snapshot, options);
