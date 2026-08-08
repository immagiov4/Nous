// Builds metadata objects for persisted project records.
import { parseYouTubeTranscript } from '@shared/youtubeTranscript';
import { createEntityId } from '../utils/ids.js';
import { timestampIso } from '../utils/time.js';
import { isRecord } from '../utils/validation.js';
import type {
  LearningPlanNodeSnapshot,
  ProjectSnapshot,
  ProjectSourceKind,
  SavedProjectMeta,
} from './types.js';

const DEFAULT_PROJECT_VERSION = '4.1';
const createProjectId = (): string => createEntityId('project');

const ensureString = (value: unknown, fallback = ''): string => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const normalizeResearchSource = (value: unknown): unknown => {
  if (!isRecord(value) || !Object.hasOwn(value, 'youtubeTranscript')) return value;
  const { youtubeTranscript: rawTranscript, ...source } = value;
  const youtubeTranscript = parseYouTubeTranscript(rawTranscript);
  return youtubeTranscript ? { ...source, youtubeTranscript } : source;
};

const normalizeResearchDossiers = (value: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([sectionId, dossier]) => [
      sectionId,
      isRecord(dossier) && Array.isArray(dossier.sources)
        ? { ...dossier, sources: dossier.sources.map(normalizeResearchSource) }
        : dossier,
    ])
  );
};

const inferProjectSourceKind = (snapshot: ProjectSnapshot, imported = false): ProjectSourceKind => {
  if (snapshot.sourceKind) {
    return snapshot.sourceKind;
  }

  if (snapshot.isLearnMode) {
    return 'learn-mode';
  }

  if (isRecord(snapshot.source) && snapshot.source.kind === 'codebase-bundle') {
    return 'codebase';
  }

  if (snapshot.source) {
    return 'document';
  }

  return imported ? 'imported-json' : 'document';
};

const getProjectTitle = (snapshot: ProjectSnapshot): string => {
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

  if (
    isRecord(snapshot.source) &&
    snapshot.source.kind === 'pdf' &&
    isRecord(snapshot.source.file)
  ) {
    const fileName = ensureString(snapshot.source.file.name).trim();
    if (fileName) {
      return fileName;
    }
  }

  if (isRecord(snapshot.source) && snapshot.source.kind === 'codebase-bundle') {
    const bundleName = ensureString(snapshot.source.name).trim();
    if (bundleName) {
      return bundleName;
    }
  }

  return snapshot.isLearnMode ? 'Nuovo percorso AI' : 'Nuovo progetto';
};

const getLearningPlanLessons = (
  learningPlan: ProjectSnapshot['learningPlan']
): LearningPlanNodeSnapshot[] => {
  if (!learningPlan) {
    return [];
  }

  if (Array.isArray(learningPlan.modules)) {
    return learningPlan.modules.flatMap(module =>
      Array.isArray(module.children)
        ? module.children.filter(child => isRecord(child) && child.kind !== 'exercise')
        : []
    );
  }

  return Array.isArray(learningPlan.sections) ? learningPlan.sections : [];
};

const getLearningPlanExercises = (
  learningPlan: ProjectSnapshot['learningPlan']
): LearningPlanNodeSnapshot[] => {
  if (!learningPlan || !Array.isArray(learningPlan.modules)) {
    return [];
  }

  return learningPlan.modules.flatMap(module =>
    Array.isArray(module.children)
      ? module.children.filter(child => isRecord(child) && child.kind === 'exercise')
      : []
  );
};

const getLearningPlanLessonStats = (
  learningPlan: ProjectSnapshot['learningPlan']
): { completedCount: number; lessonCount: number } => {
  const lessons = getLearningPlanLessons(learningPlan);

  return {
    lessonCount: lessons.length,
    completedCount: lessons.filter(lesson => lesson.isCompleted).length,
  };
};

const getLearningPlanExerciseStats = (
  learningPlan: ProjectSnapshot['learningPlan']
): { completedExercises: number; exerciseCount: number } => {
  const exercises = getLearningPlanExercises(learningPlan);

  return {
    exerciseCount: exercises.length,
    completedExercises: exercises.filter(exercise => exercise.isCompleted).length,
  };
};

const buildCoverLabel = (snapshot: ProjectSnapshot, sourceKind: ProjectSourceKind): string => {
  if (
    isRecord(snapshot.source) &&
    snapshot.source.kind === 'pdf' &&
    isRecord(snapshot.source.file)
  ) {
    return ensureString(snapshot.source.file.name, 'Documento');
  }

  if (isRecord(snapshot.source) && snapshot.source.kind === 'codebase-bundle') {
    if (sourceKind === 'document') {
      return ensureString(snapshot.source.name, 'Documento');
    }

    const files = Array.isArray(snapshot.source.files) ? snapshot.source.files : [];
    return files.length > 0 ? `${files.length} file` : ensureString(snapshot.source.name, 'Codice');
  }

  if (sourceKind === 'learn-mode') {
    return 'Percorso AI';
  }

  const { lessonCount } = getLearningPlanLessonStats(snapshot.learningPlan);
  return lessonCount > 0 ? `${lessonCount} lezioni` : 'Bozza sincronizzata';
};

export const normalizeProjectSnapshot = (data: unknown, imported = false): ProjectSnapshot => {
  const now = timestampIso();
  const record = isRecord(data) ? data : {};
  const snapshot = {
    ...record,
    id: ensureString(record.id, createProjectId()),
    version: ensureString(record.version, DEFAULT_PROJECT_VERSION),
    createdAt: ensureString(record.createdAt, now),
    updatedAt: ensureString(record.updatedAt, now),
    lastOpenedAt: ensureString(record.lastOpenedAt, now),
  } as ProjectSnapshot;

  const normalizedSnapshot = {
    ...snapshot,
    researchDossiersBySectionId: normalizeResearchDossiers(snapshot.researchDossiersBySectionId),
    sourceKind: inferProjectSourceKind(snapshot, imported),
  };
  const explicitTitle = ensureString(snapshot.title);
  if (!explicitTitle) {
    return normalizedSnapshot;
  }

  return {
    ...normalizedSnapshot,
    title: explicitTitle,
    learningPlan: normalizedSnapshot.learningPlan
      ? { ...normalizedSnapshot.learningPlan, title: explicitTitle }
      : normalizedSnapshot.learningPlan,
  };
};

export const buildProjectMeta = (
  snapshot: ProjectSnapshot,
  previousMeta?: SavedProjectMeta | null,
  options?: { imported?: boolean; touchedAt?: string }
): SavedProjectMeta => {
  const now = options?.touchedAt || timestampIso();
  const sourceKind = inferProjectSourceKind(snapshot, options?.imported ?? false);
  const { completedCount, lessonCount } = getLearningPlanLessonStats(snapshot.learningPlan);
  const { completedExercises, exerciseCount } = getLearningPlanExerciseStats(snapshot.learningPlan);

  return {
    id: snapshot.id,
    title: getProjectTitle(snapshot),
    sourceKind,
    createdAt: previousMeta?.createdAt || snapshot.createdAt || now,
    updatedAt: snapshot.updatedAt || now,
    lastOpenedAt: previousMeta?.lastOpenedAt || snapshot.lastOpenedAt || now,
    lessonCount,
    completedCount,
    exerciseCount,
    completedExercises,
    hasSourceFile: Boolean(snapshot.source),
    coverLabel: buildCoverLabel(snapshot, sourceKind),
    isFavorite: previousMeta?.isFavorite ?? false,
  };
};
