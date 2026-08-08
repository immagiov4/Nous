import { createHash } from 'node:crypto';

import type { Sql } from 'postgres';

import { applyProjectPatch } from '../projects/projectPatch.js';
import { patchProjectInTransaction } from '../projects/projectTransaction.js';
import type { ProjectPatch, ProjectSnapshot, ProjectStore } from '../projects/types.js';
import { timestampIso } from '../utils/time.js';
import type {
  CourseGenerationStageContext,
  CourseGenerationWorkflowServices,
} from './courseGenerationWorkflow.js';
import type {
  CourseExercisesState,
  CoursePersistenceState,
} from './courseGenerationWorkflowContract.js';
import {
  appendProjectRevisionNotification,
  COURSE_PROJECT_REVISION_EVENT,
} from './projectRevisionNotifications.js';
import { failPermanently } from './retryPolicy.js';
import { canonicalJson } from './schemaFingerprint.js';

type TransactionProjectPatch = Omit<ProjectPatch, 'updatedAt'>;
type LockedProject = { revision: number; snapshot: ProjectSnapshot };

export class ProjectCourseGenerationTargetError extends Error {
  constructor() {
    super('The generated course target is no longer authoritative.');
    this.name = 'ProjectCourseGenerationTargetError';
  }
}

const parseOptionalJson = (value: string | null): unknown =>
  value === null ? null : JSON.parse(value);

const parseOptionalRecord = (value: string | null): Record<string, unknown> | null => {
  const parsed = parseOptionalJson(value);
  if (parsed === null) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Durable course history is invalid.');
  }
  return parsed as Record<string, unknown>;
};

const parseArray = (value: string): unknown[] => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new TypeError('Durable course history is invalid.');
  return parsed;
};

const serializeOptionalJson = (value: unknown): string | null =>
  value == null ? null : canonicalJson(value);

const firstLessonId = (input: CourseExercisesState): string | null => {
  for (const module of input.plan.modules) {
    const lesson = module.children.find(child => child.kind === 'lesson');
    if (lesson) return lesson.id;
  }
  return null;
};

const courseState = (snapshot: ProjectSnapshot) => ({
  activeSectionId: snapshot.activeSectionId ?? null,
  documentIndex: snapshot.documentIndex ?? null,
  isLearnMode: snapshot.isLearnMode ?? false,
  learningPlan: snapshot.learningPlan ?? null,
  lastCourseGenerationRunId: snapshot.lastCourseGenerationRunId ?? null,
  researchCoursePlan: snapshot.researchCoursePlan ?? null,
  researchDossiersBySectionId: snapshot.researchDossiersBySectionId ?? {},
  state: snapshot.state ?? '',
  syllabus: snapshot.syllabus ?? [],
  userProfile: snapshot.userProfile ?? null,
});

const courseStateFingerprint = (snapshot: ProjectSnapshot): string =>
  createHash('sha256')
    .update(canonicalJson(courseState(snapshot)))
    .digest('hex');

const generatedCoursePatch = (
  input: CourseExercisesState,
  runId: string
): TransactionProjectPatch => ({
  activeSectionId: firstLessonId(input),
  documentIndex: input.documentIndex,
  isLearnMode: input.request.mode === 'learn',
  lastCourseGenerationRunId: runId,
  learningPlan: input.plan,
  researchCoursePlan: input.researchCoursePlan,
  researchDossiersBySectionId: {},
  state: 'READING',
  syllabus: input.syllabus,
  userProfile: input.context.profile,
});

const previousCoursePatch = (state: CoursePersistenceState): TransactionProjectPatch => ({
  activeSectionId: state.previous.activeSectionId,
  documentIndex: parseOptionalRecord(state.previous.documentIndexJson),
  isLearnMode: state.previous.isLearnMode,
  lastCourseGenerationRunId: state.previous.lastCourseGenerationRunId,
  learningPlan: parseOptionalRecord(state.previous.learningPlanJson),
  researchCoursePlan: parseOptionalRecord(state.previous.researchCoursePlanJson),
  researchDossiersBySectionId: parseOptionalRecord(state.previous.researchDossiersJson) ?? {},
  state: state.previous.state,
  syllabus: parseArray(state.previous.syllabusJson),
  userProfile: parseOptionalRecord(state.previous.userProfileJson),
});

const assertUniqueCourseNodeIds = (input: CourseExercisesState): void => {
  const nodeIds = new Set<string>();
  for (const module of input.plan.modules) {
    for (const id of [module.id, ...module.children.map(child => child.id)]) {
      if (nodeIds.has(id)) {
        throw failPermanently({
          code: 'course_plan_ids_invalid',
          message: 'The generated course contains duplicate node identifiers.',
        });
      }
      nodeIds.add(id);
    }
  }
};

const assertPersistenceIdentity = (
  input: CourseExercisesState,
  state: CoursePersistenceState
): void => {
  if (
    state.result.projectId !== input.request.projectId ||
    state.userId !== input.request.userId ||
    state.result.firstSectionId !== firstLessonId(input)
  ) {
    throw new ProjectCourseGenerationTargetError();
  }
};

const buildPersistenceState = (
  project: LockedProject,
  context: CourseGenerationStageContext<CourseExercisesState>,
  persistedAt: string
): CoursePersistenceState => {
  if (
    project.snapshot.id !== context.input.request.projectId ||
    project.revision !== context.input.projectRevision
  ) {
    throw new ProjectCourseGenerationTargetError();
  }
  const firstSectionId = firstLessonId(context.input);
  if (!firstSectionId) {
    throw failPermanently({
      code: 'course_plan_empty',
      message: 'The generated course does not contain a readable lesson.',
    });
  }
  assertUniqueCourseNodeIds(context.input);
  const committed = applyProjectPatch(
    project.snapshot,
    generatedCoursePatch(context.input, context.execution.runId),
    persistedAt
  );
  return {
    committedCourseFingerprint: courseStateFingerprint(committed),
    committedRunId: context.execution.runId,
    persistedAt,
    previous: {
      activeSectionId: project.snapshot.activeSectionId ?? null,
      documentIndexJson: serializeOptionalJson(project.snapshot.documentIndex),
      isLearnMode: project.snapshot.isLearnMode ?? false,
      lastCourseGenerationRunId: project.snapshot.lastCourseGenerationRunId ?? null,
      learningPlanJson: serializeOptionalJson(project.snapshot.learningPlan),
      researchCoursePlanJson: serializeOptionalJson(project.snapshot.researchCoursePlan),
      researchDossiersJson: serializeOptionalJson(project.snapshot.researchDossiersBySectionId),
      state: project.snapshot.state ?? '',
      syllabusJson: canonicalJson(project.snapshot.syllabus ?? []),
      userProfileJson: serializeOptionalJson(project.snapshot.userProfile),
    },
    result: {
      firstSectionId,
      projectId: context.input.request.projectId,
      projectRevision: project.revision + 1,
    },
    stage: 'persistence',
    userId: context.input.request.userId,
  };
};

export const createCoursePersistenceStage =
  ({
    loadProjectWithRevision,
    now = timestampIso,
  }: {
    readonly loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
    readonly now?: () => string;
  }): CourseGenerationWorkflowServices['buildCoursePersistence'] =>
  async context => {
    const { projectId, userId } = context.input.request;
    const project = await loadProjectWithRevision(userId, projectId);
    if (!project) {
      throw failPermanently({
        code: 'course_project_missing',
        message: 'The course project no longer exists.',
      });
    }
    try {
      return buildPersistenceState(project, context, now());
    } catch (error) {
      if (error instanceof ProjectCourseGenerationTargetError) {
        throw failPermanently({
          code: 'course_generation_target_changed',
          message: 'The course changed during generation.',
        });
      }
      throw error;
    }
  };

export const buildCourseGenerationCommitPatch = (
  project: LockedProject,
  input: CourseExercisesState,
  state: CoursePersistenceState,
  execution: CourseGenerationStageContext<unknown>['execution']
): TransactionProjectPatch => {
  assertPersistenceIdentity(input, state);
  if (
    project.snapshot.id !== state.result.projectId ||
    project.revision !== input.projectRevision ||
    state.committedRunId !== execution.runId
  ) {
    throw new ProjectCourseGenerationTargetError();
  }
  const patch = generatedCoursePatch(input, execution.runId);
  const committed = applyProjectPatch(project.snapshot, patch, state.persistedAt);
  if (courseStateFingerprint(committed) !== state.committedCourseFingerprint) {
    throw new ProjectCourseGenerationTargetError();
  }
  return patch;
};

export const buildCourseGenerationUndoPatch = (
  project: LockedProject,
  state: CoursePersistenceState
): TransactionProjectPatch | null => {
  if (project.snapshot.id !== state.result.projectId) {
    throw new ProjectCourseGenerationTargetError();
  }
  const previous = previousCoursePatch(state);
  const previousSnapshot = applyProjectPatch(
    project.snapshot,
    previous,
    project.snapshot.updatedAt
  );
  const currentFingerprint = courseStateFingerprint(project.snapshot);
  const previousFingerprint = courseStateFingerprint(previousSnapshot);
  if (currentFingerprint === previousFingerprint) return null;
  if (
    project.revision !== state.result.projectRevision ||
    project.snapshot.lastCourseGenerationRunId !== state.committedRunId ||
    currentFingerprint !== state.committedCourseFingerprint
  ) {
    throw new ProjectCourseGenerationTargetError();
  }
  return previous;
};

export const createCourseResultFinalizer =
  ({
    loadProjectWithRevision,
  }: {
    readonly loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
  }): CourseGenerationWorkflowServices['finalizeCourse'] =>
  async context => {
    const state = context.input;
    const project = await loadProjectWithRevision(state.userId, state.result.projectId);
    if (
      project?.snapshot.lastCourseGenerationRunId !== state.committedRunId ||
      (project && courseStateFingerprint(project.snapshot) !== state.committedCourseFingerprint)
    ) {
      throw failPermanently({
        code: 'course_generation_commit_changed',
        message: 'The committed course changed before finalization.',
      });
    }
    return { ...state.result, projectRevision: project.revision };
  };

export class PostgresCourseGenerationPersistence {
  private readonly appendRevision: typeof appendProjectRevisionNotification;
  private readonly now: () => string;
  private readonly patchProject: typeof patchProjectInTransaction;
  private readonly sql: Pick<Sql, 'begin'>;

  constructor(options: {
    readonly appendRevision?: typeof appendProjectRevisionNotification;
    readonly now?: () => string;
    readonly patchProject?: typeof patchProjectInTransaction;
    readonly sql: Pick<Sql, 'begin'>;
  }) {
    this.appendRevision = options.appendRevision ?? appendProjectRevisionNotification;
    this.now = options.now ?? timestampIso;
    this.patchProject = options.patchProject ?? patchProjectInTransaction;
    this.sql = options.sql;
  }

  readonly persistCourse: CourseGenerationWorkflowServices['persistCourse'] = async ({
    execution,
    input,
    output,
    transaction,
  }) => {
    await this.patchProject(transaction, {
      buildPatch: project => buildCourseGenerationCommitPatch(project, input, output, execution),
      projectId: input.request.projectId,
      updatedAt: output.persistedAt,
      userId: input.request.userId,
    });
  };

  readonly undoCourse: CourseGenerationWorkflowServices['undoCourse'] = async ({
    execution,
    input,
    output,
    signal,
  }) => {
    signal.throwIfAborted();
    await this.sql.begin(async transaction => {
      signal.throwIfAborted();
      const saved = await this.patchProject(transaction, {
        buildPatch: project => buildCourseGenerationUndoPatch(project, output),
        projectId: output.result.projectId,
        updatedAt: this.now(),
        userId: input.request.userId,
      });
      if (!saved.projectChanged) return;
      if (typeof saved.meta.revision !== 'number') {
        throw new TypeError('The restored course revision is missing.');
      }
      await this.appendRevision(transaction, {
        eventType: COURSE_PROJECT_REVISION_EVENT,
        projectId: output.result.projectId,
        revision: saved.meta.revision,
        runId: execution.runId,
      });
    });
  };
}
