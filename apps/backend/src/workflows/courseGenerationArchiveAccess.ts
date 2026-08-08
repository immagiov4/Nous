import { SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES } from '@shared/sourceArchiveSelectors';

import {
  createProjectSourceArchiveAccess,
  type SourceArchiveAccess,
} from '../projects/sourceArchiveAccess.js';
import type {
  ProjectSourceArchiveIndex,
  ProjectSourceArchiveVersion,
  ProjectStore,
} from '../projects/types.js';
import type { CoursePreparationState } from './courseGenerationWorkflowContract.js';
import { failPermanently } from './retryPolicy.js';

type CourseArchiveState = Pick<CoursePreparationState, 'context' | 'projectRevision' | 'request'>;

export interface OpenedCourseArchive {
  readonly access: SourceArchiveAccess;
  readonly index: ProjectSourceArchiveIndex;
}

const sourceChanged = () =>
  failPermanently({
    code: 'course_source_changed',
    message: 'The course source changed after generation started.',
  });

const requireArchiveDescriptor = (state: CourseArchiveState) => {
  const archives = state.context.sources.filter(source => source.kind === 'archive');
  if (archives.length !== 1) {
    throw failPermanently({
      code: 'course_archive_missing',
      message: 'The course archive source is not available.',
    });
  }
  return archives[0];
};

const versionsMatch = (
  version: ProjectSourceArchiveVersion,
  descriptor: ReturnType<typeof requireArchiveDescriptor>
): boolean => version.sourceId === descriptor.id && version.sourceHash === descriptor.hash;

export const createCourseArchiveOpener =
  ({
    loadProjectSourceArchiveEntry,
    loadProjectSourceArchiveEntryRange,
    loadProjectSourceArchiveIndex,
    loadProjectWithRevision,
  }: {
    readonly loadProjectSourceArchiveEntry: ProjectStore['loadProjectSourceArchiveEntry'];
    readonly loadProjectSourceArchiveEntryRange: ProjectStore['loadProjectSourceArchiveEntryRange'];
    readonly loadProjectSourceArchiveIndex: ProjectStore['loadProjectSourceArchiveIndex'];
    readonly loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
  }) =>
  async (state: CourseArchiveState, signal: AbortSignal): Promise<OpenedCourseArchive> => {
    signal.throwIfAborted();
    const descriptor = requireArchiveDescriptor(state);
    const project = await loadProjectWithRevision(state.request.userId, state.request.projectId);
    if (project?.revision !== state.projectRevision) throw sourceChanged();

    const index = await loadProjectSourceArchiveIndex(
      state.request.userId,
      state.request.projectId
    );
    signal.throwIfAborted();
    if (!index || !versionsMatch(index.version, descriptor)) throw sourceChanged();

    return {
      access: createProjectSourceArchiveAccess({
        index,
        maxContextBytes: SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES,
        projectId: state.request.projectId,
        signal,
        sourceUnavailableError: sourceChanged,
        store: { loadProjectSourceArchiveEntry, loadProjectSourceArchiveEntryRange },
        userId: state.request.userId,
      }),
      index,
    };
  };
