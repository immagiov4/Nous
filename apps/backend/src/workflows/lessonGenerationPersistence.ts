import { isDeepStrictEqual } from 'node:util';

import type { Sql } from 'postgres';

import type { ProjectAssetWriter } from '../projects/projectAsset.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import { applyProjectPatch } from '../projects/projectPatch.js';
import { patchProjectInTransaction } from '../projects/projectTransaction.js';
import type {
  LearningPlanNodeSnapshot,
  LearningPlanSnapshot,
  ProjectPatch,
  ProjectSnapshot,
  ProjectStore,
} from '../projects/types.js';
import { buildResearchDossier } from '../services/lessonGenerationResearch.js';
import { mergeProjectDocumentAssets } from '../services/lessonGenerationSources.js';
import { timestampIso } from '../utils/time.js';
import { isRecord } from '../utils/validation.js';
import { CourseLessonSchema } from './courseGenerationWorkflowContract.js';
import {
  buildLessonGenerationSourceFingerprint,
  buildLessonGenerationTargetFingerprint,
  snapshotLessonGenerationTarget,
} from './lessonGenerationAuthority.js';
import type {
  LessonGenerationStageContext,
  LessonGenerationWorkflowServices,
} from './lessonGenerationWorkflow.js';
import type {
  LessonPersistenceState,
  LessonVisualsState,
  SublessonPlanState,
  SublessonReadyState,
} from './lessonGenerationWorkflowContract.js';
import {
  LessonDocumentAssetsSchema,
  LessonResearchDossierSchema,
} from './lessonGenerationWorkflowSchemas.js';
import { collectProjectLessonVisualAssetIds } from './lessonVisualPersistence.js';
import {
  appendProjectRevisionNotification,
  LESSON_PROJECT_REVISION_EVENT,
} from './projectRevisionNotifications.js';
import { failPermanently } from './retryPolicy.js';
import { canonicalJson } from './schemaFingerprint.js';
import type { WorkflowStepExecutionIdentity } from './types.js';

type TransactionProjectPatch = Omit<ProjectPatch, 'updatedAt'>;
type LockedProject = { revision: number; snapshot: ProjectSnapshot };

export class ProjectLessonGenerationTargetError extends Error {
  constructor() {
    super('The generated lesson target is no longer authoritative.');
    this.name = 'ProjectLessonGenerationTargetError';
  }
}

const parseRecord = (value: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new TypeError('Durable lesson state is invalid.');
  return parsed;
};

const parseOptionalJson = (value: string | null): unknown =>
  value === null ? undefined : JSON.parse(value);

const serializeOwnProperty = (record: object, key: PropertyKey): string | null =>
  Object.hasOwn(record, key) ? canonicalJson((record as Record<PropertyKey, unknown>)[key]) : null;

const assertStateTarget = (project: ProjectSnapshot, input: LessonVisualsState): void => {
  const { projectId, sectionId } = input.request;
  if (
    project.id !== projectId ||
    !findProjectLessonSection(project, sectionId) ||
    buildLessonGenerationSourceFingerprint(project, sectionId) !== input.sourceFingerprint ||
    buildLessonGenerationTargetFingerprint(project, sectionId) !== input.targetFingerprint
  ) {
    throw new ProjectLessonGenerationTargetError();
  }
};

const sectionCommitPatch = (
  input: LessonVisualsState,
  runId: string
): NonNullable<TransactionProjectPatch['section']> => ({
  content: input.content,
  contentBlocks: input.contentBlocks,
  generationWarnings: input.warnings,
  generatedVisuals: input.generatedVisuals,
  imageRefs: input.imageRefs,
  learningAids: input.learningAids,
  lastGenerationRunId: runId,
  quiz: input.quiz,
  sectionId: input.request.sectionId,
  visualPlanningDecision: input.visualPlanningDecision,
});

const committedTargetFingerprint = (
  project: ProjectSnapshot,
  input: LessonVisualsState,
  runId: string,
  persistedAt: string
): string =>
  buildLessonGenerationTargetFingerprint(
    applyProjectPatch(project, { section: sectionCommitPatch(input, runId) }, persistedAt),
    input.request.sectionId
  );

const buildPersistenceState = (
  project: ProjectSnapshot,
  context: LessonGenerationStageContext<LessonVisualsState>,
  persistedAt: string
): LessonPersistenceState => {
  assertStateTarget(project, context.input);
  const { input } = context;
  const { projectId, sectionId } = input.request;
  const existingDossier = input.existingDossierJson ? parseRecord(input.existingDossierJson) : null;
  const researchDossier = LessonResearchDossierSchema.parse(
    buildResearchDossier({
      contentBlocks: input.contentBlocks,
      existingDossier,
      generatedAt: persistedAt,
      lessonSources: input.lessonSources,
      researchSummary: input.research.summary,
      sectionId,
      sectionTitle: input.lessonInputData.sectionTitle,
      youtubeOutcome: input.research.youtube,
    })
  );
  const dossierBySection = project.researchDossiersBySectionId ?? {};
  return {
    committedTargetFingerprint: committedTargetFingerprint(
      project,
      input,
      context.execution.runId,
      persistedAt
    ),
    persistedAt,
    previous: {
      documentAssetsJson: serializeOwnProperty(project, 'documentAssets'),
      researchDossierJson: serializeOwnProperty(dossierBySection, sectionId),
      sectionJson: canonicalJson(snapshotLessonGenerationTarget(project, sectionId)),
    },
    result: {
      content: input.content,
      contentBlocks: input.contentBlocks,
      documentAssets: input.documentAssets,
      generatedVisuals: input.generatedVisuals,
      imageRefs: input.imageRefs,
      learningAids: input.learningAids,
      projectId,
      quiz: input.quiz,
      researchDossier,
      sectionId,
      visualPlanningDecision: input.visualPlanningDecision,
      warnings: input.warnings,
    },
    stage: 'persistence',
    userId: input.request.userId,
  };
};

export const createLessonPersistenceStage =
  ({
    loadProject,
    now = timestampIso,
  }: {
    readonly loadProject: ProjectStore['loadProject'];
    readonly now?: () => string;
  }): LessonGenerationWorkflowServices['buildLessonPersistence'] =>
  async context => {
    const { projectId, userId } = context.input.request;
    const project = await loadProject(userId, projectId);
    if (!project) {
      throw failPermanently({
        code: 'lesson_project_missing',
        message: 'The lesson project no longer exists.',
      });
    }
    try {
      return buildPersistenceState(project, context, now());
    } catch (error) {
      if (error instanceof ProjectLessonGenerationTargetError) {
        throw failPermanently({
          code: 'lesson_generation_target_changed',
          message: 'The lesson changed during generation.',
        });
      }
      throw error;
    }
  };

export const createLessonResultFinalizer =
  ({
    loadProjectWithRevision,
  }: {
    readonly loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
  }): LessonGenerationWorkflowServices['finalizeLesson'] =>
  async context => {
    const state = context.input;
    const record = await loadProjectWithRevision(state.userId, state.result.projectId);
    const section = record
      ? findProjectLessonSection(record.snapshot, state.result.sectionId)
      : null;
    if (
      !record ||
      section?.lastGenerationRunId !== context.execution.runId ||
      buildLessonGenerationTargetFingerprint(record.snapshot, state.result.sectionId) !==
        state.committedTargetFingerprint
    ) {
      throw failPermanently({
        code: 'lesson_generation_commit_changed',
        message: 'The committed lesson changed before finalization.',
      });
    }

    const documentAssets =
      record.snapshot.documentAssets == null
        ? null
        : LessonDocumentAssetsSchema.parse(record.snapshot.documentAssets);
    return {
      ...state.result,
      documentAssets,
      projectRevision: record.revision,
    };
  };

const assertPersistenceIdentity = (
  input: LessonVisualsState,
  state: LessonPersistenceState
): void => {
  if (
    state.result.projectId !== input.request.projectId ||
    state.result.sectionId !== input.request.sectionId
  ) {
    throw new ProjectLessonGenerationTargetError();
  }
};

const persistedResearchDossier = (
  input: LessonVisualsState,
  state: LessonPersistenceState
): Record<string, unknown> => ({
  ...(input.existingDossierJson ? parseRecord(input.existingDossierJson) : {}),
  ...state.result.researchDossier,
});

export const buildLessonGenerationCommitPatch = (
  project: LockedProject,
  input: LessonVisualsState,
  state: LessonPersistenceState,
  execution: WorkflowStepExecutionIdentity
): TransactionProjectPatch => {
  assertPersistenceIdentity(input, state);
  assertStateTarget(project.snapshot, input);
  if (
    committedTargetFingerprint(project.snapshot, input, execution.runId, state.persistedAt) !==
    state.committedTargetFingerprint
  ) {
    throw new ProjectLessonGenerationTargetError();
  }
  const documentAssets = mergeProjectDocumentAssets(
    project.snapshot,
    input.request.sectionId,
    state.result.documentAssets,
    state.result.imageRefs
  );
  return {
    ...(documentAssets ? { documentAssets } : {}),
    researchDossiersBySectionId: {
      ...project.snapshot.researchDossiersBySectionId,
      [input.request.sectionId]: persistedResearchDossier(input, state),
    },
    section: sectionCommitPatch(input, execution.runId),
  };
};

const restoredSectionPatch = (
  sectionId: string,
  previous: Record<string, unknown>
): NonNullable<TransactionProjectPatch['section']> => ({
  content: typeof previous.content === 'string' ? previous.content : null,
  contentBlocks: Array.isArray(previous.contentBlocks) ? previous.contentBlocks : null,
  generationWarnings: Array.isArray(previous.generationWarnings)
    ? previous.generationWarnings
    : null,
  generatedVisuals: Array.isArray(previous.generatedVisuals) ? previous.generatedVisuals : null,
  imageRefs: Array.isArray(previous.imageRefs) ? previous.imageRefs : null,
  learningAids: Array.isArray(previous.learningAids) ? previous.learningAids : null,
  lastGenerationRunId:
    typeof previous.lastGenerationRunId === 'string' ? previous.lastGenerationRunId : null,
  quiz: Array.isArray(previous.quiz) ? previous.quiz : null,
  sectionId,
  visualPlanningDecision: previous.visualPlanningDecision ?? null,
});

const restoredDossiers = (
  project: ProjectSnapshot,
  sectionId: string,
  previousJson: string | null
): Record<string, unknown> => {
  const dossiers = { ...project.researchDossiersBySectionId };
  if (previousJson === null) delete dossiers[sectionId];
  else dossiers[sectionId] = JSON.parse(previousJson);
  return dossiers;
};

const isAlreadyUndone = (
  project: ProjectSnapshot,
  input: LessonVisualsState,
  state: LessonPersistenceState
): boolean => {
  const previousDossier = parseOptionalJson(state.previous.researchDossierJson);
  return (
    buildLessonGenerationTargetFingerprint(project, input.request.sectionId) ===
      input.targetFingerprint &&
    isDeepStrictEqual(
      project.researchDossiersBySectionId?.[input.request.sectionId],
      previousDossier
    )
  );
};

export const buildLessonGenerationUndoPatch = (
  project: LockedProject,
  input: LessonVisualsState,
  state: LessonPersistenceState,
  execution: WorkflowStepExecutionIdentity
): TransactionProjectPatch | null => {
  const { projectId, sectionId } = state.result;
  assertPersistenceIdentity(input, state);
  if (project.snapshot.id !== projectId || !findProjectLessonSection(project.snapshot, sectionId)) {
    throw new ProjectLessonGenerationTargetError();
  }
  if (isAlreadyUndone(project.snapshot, input, state)) return null;
  if (
    buildLessonGenerationTargetFingerprint(project.snapshot, sectionId) !==
      state.committedTargetFingerprint ||
    !isDeepStrictEqual(
      project.snapshot.researchDossiersBySectionId?.[sectionId],
      persistedResearchDossier(input, state)
    ) ||
    findProjectLessonSection(project.snapshot, sectionId)?.lastGenerationRunId !== execution.runId
  ) {
    throw new ProjectLessonGenerationTargetError();
  }

  const previousSection = parseRecord(state.previous.sectionJson);
  const previousDocumentAssets = parseOptionalJson(state.previous.documentAssetsJson);
  const documentAssets = mergeProjectDocumentAssets(
    project.snapshot,
    sectionId,
    previousDocumentAssets,
    previousSection.imageRefs
  );
  const hadDocumentAssets = state.previous.documentAssetsJson !== null;
  return {
    documentAssets:
      documentAssets &&
      (hadDocumentAssets ||
        (Array.isArray(documentAssets.usedImages) && documentAssets.usedImages.length > 0))
        ? documentAssets
        : null,
    researchDossiersBySectionId: restoredDossiers(
      project.snapshot,
      sectionId,
      state.previous.researchDossierJson
    ),
    section: restoredSectionPatch(sectionId, previousSection),
  };
};

const isDescendantOf = (
  node: LearningPlanNodeSnapshot,
  ancestorId: string,
  nodesById: ReadonlyMap<string, LearningPlanNodeSnapshot>
): boolean => {
  const visited = new Set<string>();
  let parentId = typeof node.parentId === 'string' ? node.parentId : null;
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    parentId = parent && typeof parent.parentId === 'string' ? parent.parentId : null;
  }
  return false;
};

const insertSublesson = (
  lessons: LearningPlanNodeSnapshot[],
  parentSectionId: string,
  section: SublessonReadyState['section']
): LearningPlanNodeSnapshot[] => {
  const parentIndex = lessons.findIndex(lesson => lesson.id === parentSectionId);
  if (parentIndex < 0) throw new ProjectLessonGenerationTargetError();
  const nodesById = new Map(
    lessons.flatMap(lesson => (typeof lesson.id === 'string' ? [[lesson.id, lesson] as const] : []))
  );
  let insertIndex = parentIndex + 1;
  while (
    insertIndex < lessons.length &&
    isDescendantOf(lessons[insertIndex], parentSectionId, nodesById)
  ) {
    insertIndex += 1;
  }
  return [...lessons.slice(0, insertIndex), section, ...lessons.slice(insertIndex)];
};

const updateSublessonPlan = (
  plan: LearningPlanSnapshot | null | undefined,
  state: SublessonPlanState | SublessonReadyState,
  operation: 'insert' | 'remove'
): LearningPlanSnapshot => {
  if (!plan?.modules) throw new ProjectLessonGenerationTargetError();
  let matchedModule = false;
  const modules = plan.modules.map(module => {
    if (!module.children?.some(child => child.id === state.parentSectionId)) return module;
    matchedModule = true;
    const lessons = module.children.filter(child => child.kind !== 'exercise');
    const exercises = module.children.filter(child => child.kind === 'exercise');
    return {
      ...module,
      children:
        operation === 'insert'
          ? [...insertSublesson(lessons, state.parentSectionId, state.section), ...exercises]
          : [...lessons.filter(lesson => lesson.id !== state.section.id), ...exercises],
    };
  });
  if (!matchedModule) throw new ProjectLessonGenerationTargetError();
  return { ...plan, modules };
};

export const insertSublessonInLearningPlan = (
  plan: LearningPlanSnapshot | null | undefined,
  state: SublessonPlanState | SublessonReadyState
): LearningPlanSnapshot => updateSublessonPlan(plan, state, 'insert');

export const buildSublessonCommitPatch = (
  project: LockedProject,
  state: SublessonReadyState
): TransactionProjectPatch => {
  if (
    project.snapshot.id !== state.request.projectId ||
    project.revision !== state.projectRevision ||
    findProjectLessonSection(project.snapshot, state.section.id)
  ) {
    throw new ProjectLessonGenerationTargetError();
  }
  return {
    activeSectionId: state.section.id,
    ...(state.createdDocumentIndex ? { documentIndex: state.createdDocumentIndex } : {}),
    learningPlan: insertSublessonInLearningPlan(project.snapshot.learningPlan, state),
  };
};

export const buildSublessonUndoPatch = (
  project: ProjectSnapshot,
  state: SublessonReadyState
): TransactionProjectPatch | null => {
  if (project.id !== state.request.projectId) throw new ProjectLessonGenerationTargetError();
  const section = findProjectLessonSection(project, state.section.id);
  if (!section) {
    return project.activeSectionId === state.section.id
      ? { activeSectionId: state.previousActiveSectionId }
      : null;
  }
  if (!isDeepStrictEqual(CourseLessonSchema.parse(section), state.section)) {
    throw new ProjectLessonGenerationTargetError();
  }
  if (
    state.createdDocumentIndex &&
    !isDeepStrictEqual(project.documentIndex, state.createdDocumentIndex)
  ) {
    throw new ProjectLessonGenerationTargetError();
  }
  return {
    ...(project.activeSectionId === state.section.id
      ? { activeSectionId: state.previousActiveSectionId }
      : {}),
    ...(state.createdDocumentIndex ? { documentIndex: null } : {}),
    learningPlan: updateSublessonPlan(project.learningPlan, state, 'remove'),
  };
};

const assertSublessonStateIdentity = (
  input: SublessonPlanState,
  output: SublessonReadyState
): void => {
  if (
    input.projectRevision !== output.projectRevision ||
    input.parentSectionId !== output.parentSectionId ||
    input.request.projectId !== output.request.projectId ||
    input.request.sectionId !== output.request.sectionId ||
    input.request.userId !== output.request.userId
  ) {
    throw new ProjectLessonGenerationTargetError();
  }
};

type LessonAssetTransactions = Pick<ProjectAssetWriter, 'adoptNodeAssets'>;

interface PostgresLessonGenerationPersistenceOptions {
  readonly appendRevision?: typeof appendProjectRevisionNotification;
  readonly assets: LessonAssetTransactions;
  readonly now?: () => string;
  readonly patchProject?: typeof patchProjectInTransaction;
  readonly sql: Pick<Sql, 'begin'>;
}

const referencedAssetIds = (state: LessonPersistenceState): Set<string> => {
  const referencedImageIds = new Set(state.result.imageRefs.map(reference => reference.assetId));
  const documentAssetIds =
    state.result.documentAssets?.usedImages.flatMap(image =>
      referencedImageIds.has(image.id) ? [image.asset.id] : []
    ) ?? [];
  return new Set([
    ...documentAssetIds,
    ...state.result.generatedVisuals.flatMap(visual => collectProjectLessonVisualAssetIds(visual)),
  ]);
};

export class PostgresLessonGenerationPersistence {
  private readonly appendRevision: typeof appendProjectRevisionNotification;
  private readonly assets: LessonAssetTransactions;
  private readonly now: () => string;
  private readonly patchProject: typeof patchProjectInTransaction;
  private readonly sql: Pick<Sql, 'begin'>;

  constructor(options: PostgresLessonGenerationPersistenceOptions) {
    this.appendRevision = options.appendRevision ?? appendProjectRevisionNotification;
    this.assets = options.assets;
    this.now = options.now ?? timestampIso;
    this.patchProject = options.patchProject ?? patchProjectInTransaction;
    this.sql = options.sql;
  }

  readonly persistLesson: LessonGenerationWorkflowServices['persistLesson'] = async ({
    execution,
    input,
    output,
    transaction,
  }) => {
    const referenced = referencedAssetIds(output);
    for (const owner of [...input.documentAssetOwners, ...input.visualAssetOwners]) {
      await this.assets.adoptNodeAssets(transaction, {
        assetIds: owner.assetIds.filter(assetId => referenced.has(assetId)),
        nodeInstanceId: owner.nodeInstanceId,
        projectId: input.request.projectId,
        runId: execution.runId,
        userId: input.request.userId,
      });
    }
    await this.patchProject(transaction, {
      buildPatch: project => buildLessonGenerationCommitPatch(project, input, output, execution),
      projectId: input.request.projectId,
      updatedAt: output.persistedAt,
      userId: input.request.userId,
    });
  };

  readonly persistSublesson: LessonGenerationWorkflowServices['persistSublesson'] = async ({
    input,
    output,
    transaction,
  }) => {
    assertSublessonStateIdentity(input, output);
    await this.patchProject(transaction, {
      buildPatch: project => buildSublessonCommitPatch(project, output),
      projectId: output.request.projectId,
      updatedAt: this.now(),
      userId: output.request.userId,
    });
  };

  readonly undoLesson: LessonGenerationWorkflowServices['undoLesson'] = async ({
    execution,
    input,
    output,
    signal,
  }) => {
    signal.throwIfAborted();
    await this.sql.begin(async transaction => {
      signal.throwIfAborted();
      const saved = await this.patchProject(transaction, {
        buildPatch: project => buildLessonGenerationUndoPatch(project, input, output, execution),
        projectId: output.result.projectId,
        updatedAt: this.now(),
        userId: input.request.userId,
      });
      if (!saved.projectChanged) return;
      if (typeof saved.meta.revision !== 'number') {
        throw new TypeError('The restored lesson revision is missing.');
      }
      await this.appendRevision(transaction, {
        eventType: LESSON_PROJECT_REVISION_EVENT,
        projectId: output.result.projectId,
        revision: saved.meta.revision,
        runId: execution.runId,
      });
    });
  };

  readonly undoSublesson: LessonGenerationWorkflowServices['undoSublesson'] = async ({
    execution,
    input,
    output,
    signal,
  }) => {
    assertSublessonStateIdentity(input, output);
    signal.throwIfAborted();
    await this.sql.begin(async transaction => {
      signal.throwIfAborted();
      const saved = await this.patchProject(transaction, {
        buildPatch: project => buildSublessonUndoPatch(project.snapshot, output),
        projectId: output.request.projectId,
        updatedAt: this.now(),
        userId: output.request.userId,
      });
      if (!saved.projectChanged) return;
      if (typeof saved.meta.revision !== 'number') {
        throw new TypeError('The restored sublesson revision is missing.');
      }
      await this.appendRevision(transaction, {
        eventType: LESSON_PROJECT_REVISION_EVENT,
        projectId: output.request.projectId,
        revision: saved.meta.revision,
        runId: execution.runId,
      });
    });
  };
}
