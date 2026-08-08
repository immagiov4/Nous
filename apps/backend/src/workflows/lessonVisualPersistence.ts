import { isDeepStrictEqual } from 'node:util';

import type { ProjectLessonVisual } from '@shared/projectAsset';
import type { Sql } from 'postgres';

import type { ProjectAssetWriter } from '../projects/projectAsset.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import { patchProjectInTransaction } from '../projects/projectTransaction.js';
import type { ProjectPatch, ProjectSnapshot, ProjectStore } from '../projects/types.js';
import { timestampIso } from '../utils/time.js';
import { isRecord } from '../utils/validation.js';
import { buildLessonVisualContextFingerprint } from './lessonVisualContext.js';
import type {
  LessonVisualRetryWorkflowResult,
  LessonVisualWorkflowResult,
  LessonVisualWorkflowServices,
} from './lessonVisualWorkflow.js';
import {
  appendProjectRevisionNotification,
  LESSON_PROJECT_REVISION_EVENT,
} from './projectRevisionNotifications.js';
import { failPermanently } from './retryPolicy.js';

type TransactionProjectPatch = Omit<ProjectPatch, 'updatedAt'>;
type LockedProject = { revision: number; snapshot: ProjectSnapshot };
const VISUAL_GENERATION_WARNING_CODE = 'lesson_visual_generation_incomplete';

export class ProjectLessonVisualTargetError extends Error {
  constructor() {
    super('The lesson visual retry target is no longer authoritative.');
    this.name = 'ProjectLessonVisualTargetError';
  }
}

const readLessonArrays = (section: Record<string, unknown>) => {
  if (!Array.isArray(section.contentBlocks) || !Array.isArray(section.generatedVisuals)) {
    throw new ProjectLessonVisualTargetError();
  }
  return {
    contentBlocks: section.contentBlocks,
    generatedVisuals: section.generatedVisuals,
  };
};

const readGenerationWarnings = (section: Record<string, unknown>): unknown[] =>
  Array.isArray(section.generationWarnings) ? section.generationWarnings : [];

const isVisualGenerationWarningForSlot = (warning: unknown, slotId: string): boolean =>
  isRecord(warning) &&
  warning.code === VISUAL_GENERATION_WARNING_CODE &&
  warning.stage === 'visuals' &&
  warning.subjectId === slotId;

const createVisualGenerationWarning = (subjectId: string) => ({
  code: VISUAL_GENERATION_WARNING_CODE,
  stage: 'visuals',
  subjectId,
});

const findSingleSlotIndex = (contentBlocks: unknown[], slotId: string): number => {
  const indexes = contentBlocks.flatMap((block, index) =>
    isRecord(block) && block.type === 'generated-visual' && block.slotId === slotId ? [index] : []
  );
  if (indexes.length !== 1 || indexes[0] === undefined) {
    throw new ProjectLessonVisualTargetError();
  }
  return indexes[0];
};

const assertProjectTarget = (project: LockedProject, result: LessonVisualWorkflowResult): void => {
  if (project.snapshot.id !== result.target.projectId) {
    throw new ProjectLessonVisualTargetError();
  }
};

export const buildLessonVisualRetryCommitPatch = (
  project: LockedProject,
  result: LessonVisualWorkflowResult
): TransactionProjectPatch => {
  assertProjectTarget(project, result);
  const section = findProjectLessonSection(project.snapshot, result.target.sectionId);
  if (!section) throw new ProjectLessonVisualTargetError();
  if (
    typeof section.content !== 'string' ||
    typeof section.description !== 'string' ||
    typeof section.title !== 'string' ||
    buildLessonVisualContextFingerprint({
      lessonMarkdown: section.content,
      sectionDescription: section.description,
      sectionTitle: section.title,
    }) !== result.target.contextFingerprint
  ) {
    throw new ProjectLessonVisualTargetError();
  }
  const { contentBlocks, generatedVisuals } = readLessonArrays(section);
  const slotIndex = findSingleSlotIndex(contentBlocks, result.visual.slotId);
  const currentBlock = contentBlocks[slotIndex];
  if (!isRecord(currentBlock)) throw new ProjectLessonVisualTargetError();
  const alreadyCommitted = currentBlock.visualId === result.visual.id;
  if (
    (!alreadyCommitted && !isDeepStrictEqual(currentBlock.retryPlan, result.target.plan)) ||
    (typeof currentBlock.visualId === 'string' && !alreadyCommitted)
  ) {
    throw new ProjectLessonVisualTargetError();
  }

  const nextBlocks = [...contentBlocks];
  nextBlocks[slotIndex] = {
    slotId: result.visual.slotId,
    type: 'generated-visual',
    visualId: result.visual.id,
  };
  const otherVisuals = generatedVisuals.filter(
    candidate =>
      !isRecord(candidate) ||
      (candidate.id !== result.visual.id && candidate.slotId !== result.visual.slotId)
  );
  const generationWarnings = readGenerationWarnings(section).filter(
    warning => !isVisualGenerationWarningForSlot(warning, result.visual.slotId)
  );
  return {
    section: {
      contentBlocks: nextBlocks,
      generationWarnings,
      generatedVisuals: [...otherVisuals, result.visual],
      sectionId: result.target.sectionId,
    },
  };
};

export const buildLessonVisualRetryUndoPatch = (
  project: LockedProject,
  result: LessonVisualWorkflowResult
): TransactionProjectPatch | null => {
  assertProjectTarget(project, result);
  const section = findProjectLessonSection(project.snapshot, result.target.sectionId);
  if (!section) throw new ProjectLessonVisualTargetError();
  const { contentBlocks, generatedVisuals } = readLessonArrays(section);
  const slotIndex = findSingleSlotIndex(contentBlocks, result.visual.slotId);
  const currentBlock = contentBlocks[slotIndex];
  if (!isRecord(currentBlock)) throw new ProjectLessonVisualTargetError();
  const alreadyUndone = isDeepStrictEqual(currentBlock.retryPlan, result.target.plan);
  if (alreadyUndone) return null;
  if (!alreadyUndone && currentBlock.visualId !== result.visual.id) {
    throw new ProjectLessonVisualTargetError();
  }

  const nextBlocks = [...contentBlocks];
  nextBlocks[slotIndex] = {
    retryPlan: result.target.plan,
    slotId: result.visual.slotId,
    type: 'generated-visual',
  };
  const generationWarnings = readGenerationWarnings(section);
  const restoredWarnings = generationWarnings.some(warning =>
    isVisualGenerationWarningForSlot(warning, result.visual.slotId)
  )
    ? generationWarnings
    : [...generationWarnings, createVisualGenerationWarning(result.visual.slotId)];
  return {
    section: {
      contentBlocks: nextBlocks,
      generationWarnings: restoredWarnings,
      generatedVisuals: generatedVisuals.filter(
        candidate => !isRecord(candidate) || candidate.id !== result.visual.id
      ),
      sectionId: result.target.sectionId,
    },
  };
};

export const collectProjectLessonVisualAssetIds = (
  visual: ProjectLessonVisual
): readonly string[] => {
  const render = visual.render;
  if (render.kind === 'image') return [render.asset.id];
  if (render.kind === 'html') return render.embeddedAssets.map(asset => asset.id);
  return [];
};

const isCommittedRetryResult = (
  project: ProjectSnapshot,
  result: LessonVisualWorkflowResult
): boolean => {
  const section = findProjectLessonSection(project, result.target.sectionId);
  if (
    !section ||
    typeof section.content !== 'string' ||
    typeof section.description !== 'string' ||
    typeof section.title !== 'string' ||
    buildLessonVisualContextFingerprint({
      lessonMarkdown: section.content,
      sectionDescription: section.description,
      sectionTitle: section.title,
    }) !== result.target.contextFingerprint ||
    !Array.isArray(section.contentBlocks) ||
    !Array.isArray(section.generatedVisuals)
  ) {
    return false;
  }
  const targetBlocks = section.contentBlocks.filter(
    block =>
      isRecord(block) &&
      block.type === 'generated-visual' &&
      block.slotId === result.visual.slotId &&
      block.visualId === result.visual.id
  );
  const targetVisuals = section.generatedVisuals.filter(
    visual => isRecord(visual) && visual.id === result.visual.id
  );
  return (
    targetBlocks.length === 1 &&
    targetVisuals.length === 1 &&
    isDeepStrictEqual(targetVisuals[0], result.visual)
  );
};

export const createLessonVisualRetryFinalizer =
  ({
    loadProjectWithRevision,
  }: {
    readonly loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
  }): LessonVisualWorkflowServices['finalizeRetryResult'] =>
  async ({ input }): Promise<LessonVisualRetryWorkflowResult> => {
    const project = await loadProjectWithRevision(input.target.userId, input.target.projectId);
    if (!project || !isCommittedRetryResult(project.snapshot, input)) {
      throw failPermanently({
        code: 'lesson_visual_retry_commit_changed',
        message: 'The committed lesson visual changed before finalization.',
      });
    }
    return { ...input, projectRevision: project.revision };
  };

type LessonVisualAssetTransactions = Pick<ProjectAssetWriter, 'adoptNodeAssets'>;

interface PostgresLessonVisualPersistenceOptions {
  readonly appendRevision?: typeof appendProjectRevisionNotification;
  readonly assets: LessonVisualAssetTransactions;
  readonly now?: () => string;
  readonly patchProject?: typeof patchProjectInTransaction;
  readonly sql: Pick<Sql, 'begin'>;
}

export class PostgresLessonVisualPersistence {
  private readonly appendRevision: typeof appendProjectRevisionNotification;
  private readonly assets: LessonVisualAssetTransactions;
  private readonly now: () => string;
  private readonly patchProject: typeof patchProjectInTransaction;
  private readonly sql: Pick<Sql, 'begin'>;

  constructor(options: PostgresLessonVisualPersistenceOptions) {
    this.appendRevision = options.appendRevision ?? appendProjectRevisionNotification;
    this.assets = options.assets;
    this.now = options.now ?? timestampIso;
    this.patchProject = options.patchProject ?? patchProjectInTransaction;
    this.sql = options.sql;
  }

  readonly persistRetryResult: LessonVisualWorkflowServices['persistRetryResult'] = async ({
    execution,
    input,
    transaction,
  }) => {
    for (const owner of input.assetOwners) {
      await this.assets.adoptNodeAssets(transaction, {
        assetIds: owner.assetIds,
        nodeInstanceId: owner.nodeInstanceId,
        projectId: input.target.projectId,
        runId: execution.runId,
        userId: input.target.userId,
      });
    }
    await this.patchProject(transaction, {
      buildPatch: project => buildLessonVisualRetryCommitPatch(project, input),
      projectId: input.target.projectId,
      updatedAt: input.visual.createdAt,
      userId: input.target.userId,
    });
  };

  readonly undoRetryResult: LessonVisualWorkflowServices['undoRetryResult'] = async ({
    execution,
    input,
    signal,
  }) => {
    signal.throwIfAborted();
    await this.sql.begin(async transaction => {
      signal.throwIfAborted();
      const saved = await this.patchProject(transaction, {
        buildPatch: project => buildLessonVisualRetryUndoPatch(project, input),
        projectId: input.target.projectId,
        updatedAt: this.now(),
        userId: input.target.userId,
      });
      if (!saved.projectChanged) return;
      if (typeof saved.meta.revision !== 'number') {
        throw new TypeError('The restored lesson visual revision is missing.');
      }
      await this.appendRevision(transaction, {
        eventType: LESSON_PROJECT_REVISION_EVENT,
        projectId: input.target.projectId,
        revision: saved.meta.revision,
        runId: execution.runId,
      });
    });
  };
}
