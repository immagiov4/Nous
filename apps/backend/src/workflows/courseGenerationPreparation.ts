import { resolveProjectSourceTextKind } from '../projects/projectSource.js';
import type { ProjectStore, StoredProjectSourceFile } from '../projects/types.js';
import { isRecord } from '../utils/validation.js';
import type { CourseGenerationWorkflowServices } from './courseGenerationWorkflow.js';
import { CoursePreparationStateSchema } from './courseGenerationWorkflowContract.js';
import { failPermanently } from './retryPolicy.js';

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readProfile = (value: unknown) => {
  if (!isRecord(value)) return null;
  const profile = {
    context: readString(value.context),
    experienceLevel: readString(value.experienceLevel),
    goals: readString(value.goals),
    language: readString(value.language),
    learningStyle: readString(value.learningStyle),
    topic: readString(value.topic),
  };
  return Object.values(profile).every(field => field.length > 0) ? profile : null;
};

const sourceDescriptors = (sources: readonly StoredProjectSourceFile[]) =>
  sources.map(source => ({
    hash: source.ref.hash,
    id: source.ref.id,
    kind: resolveProjectSourceTextKind(source.file),
    mimeType: source.file.mimeType,
    name: source.file.name,
  }));

const isArchiveSource = (value: unknown): boolean => isRecord(value) && value.kind === 'archive';

const readArchiveDescriptor = (value: unknown) => {
  if (!isRecord(value) || value.kind !== 'archive' || !isRecord(value.ref)) return null;
  const { ref } = value;
  if (
    typeof ref.id !== 'string' ||
    !ref.id ||
    typeof ref.hash !== 'string' ||
    ref.hash.length !== 64 ||
    typeof ref.mimeType !== 'string' ||
    !ref.mimeType ||
    typeof ref.name !== 'string' ||
    !ref.name ||
    typeof ref.objectPath !== 'string' ||
    !ref.objectPath
  ) {
    return null;
  }
  return {
    hash: ref.hash,
    id: ref.id,
    kind: 'archive',
    mimeType: ref.mimeType,
    name: ref.name,
  };
};

const readPersistedSourceSet = (
  value: unknown
): { descriptorCount: number; usableIds: Set<string> } | null => {
  if (!isRecord(value) || !Array.isArray(value.sources)) return null;
  const usableIds = new Set(
    value.sources.flatMap(source =>
      isRecord(source) &&
      typeof source.id === 'string' &&
      source.id.trim() &&
      source.status !== 'error'
        ? [source.id]
        : []
    )
  );
  return { descriptorCount: value.sources.length, usableIds };
};

export const createCoursePreparationStage =
  ({
    loadProjectSources,
    loadProjectWithRevision,
  }: {
    readonly loadProjectSources: ProjectStore['loadProjectSources'];
    readonly loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
  }): CourseGenerationWorkflowServices['prepareCourse'] =>
  async context => {
    const { projectId, userId } = context.input;
    const project = await loadProjectWithRevision(userId, projectId);
    if (!project) {
      throw failPermanently({
        code: 'course_project_missing',
        message: 'The course project no longer exists.',
      });
    }
    const profile = readProfile(project.snapshot.userProfile);
    const archiveSource = isArchiveSource(project.snapshot.source);
    const archiveDescriptor = readArchiveDescriptor(project.snapshot.source);
    const storedSources =
      context.input.mode === 'document' && !archiveSource
        ? await loadProjectSources(userId, projectId)
        : [];
    const persistedSourceSet = readPersistedSourceSet(project.snapshot.source);
    const sources = persistedSourceSet
      ? storedSources.filter(source => persistedSourceSet.usableIds.has(source.ref.id))
      : storedSources;
    if (context.input.mode === 'learn' && !profile) {
      throw failPermanently({
        code: 'course_profile_missing',
        message: 'The learning profile is incomplete.',
      });
    }
    if (context.input.mode === 'document' && !archiveDescriptor && sources.length === 0) {
      throw failPermanently({
        code: 'course_source_missing',
        message: 'The course source is no longer available.',
      });
    }

    const descriptors = archiveDescriptor ? [archiveDescriptor] : sourceDescriptors(sources);
    let strategy: 'archive' | 'learn' | 'single-source' | 'source-set' = 'single-source';
    if (context.input.mode === 'learn') {
      strategy = 'learn';
    } else if (archiveSource) {
      strategy = 'archive';
    } else if ((persistedSourceSet?.descriptorCount ?? sources.length) > 1) {
      strategy = 'source-set';
    }
    const sourceNames = descriptors.map(source => source.name);
    return CoursePreparationStateSchema.parse({
      context: {
        assessmentSummary: context.input.assessmentHistory
          .map(message => {
            const text = message.text.trim();
            return text ? `${message.role.toUpperCase()}: ${text}` : '';
          })
          .filter(Boolean)
          .join('\n'),
        language: profile?.language || 'Italiano',
        profile,
        sourceNames,
        sources: descriptors.map(source =>
          strategy === 'archive' ? { ...source, kind: 'archive' } : source
        ),
        topic:
          profile?.topic ||
          readString(project.snapshot.title) ||
          sourceNames.join(', ') ||
          'Nuovo percorso',
      },
      projectRevision: project.revision,
      request: {
        mode: context.input.mode,
        projectId,
        userId,
      },
      stage: 'prepared',
      strategy,
    });
  };
