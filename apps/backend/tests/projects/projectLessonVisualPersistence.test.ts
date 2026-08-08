import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import type { ProjectSnapshot } from '../../src/projects/types.js';
import { buildLessonVisualContextFingerprint } from '../../src/workflows/lessonVisualContext.js';
import {
  buildLessonVisualRetryCommitPatch,
  buildLessonVisualRetryUndoPatch,
  createLessonVisualRetryFinalizer,
  PostgresLessonVisualPersistence,
  ProjectLessonVisualTargetError,
} from '../../src/workflows/lessonVisualPersistence.js';
import type { LessonVisualWorkflowResult } from '../../src/workflows/lessonVisualWorkflow.js';

const retryPlan = {
  altText: 'Schema',
  anchorHeading: 'Titolo',
  complexity: 'simple' as const,
  concept: 'Concetto',
  coverage: 'single_complex' as const,
  coverageRationale: 'Motivo',
  factualRequirements: ['Vincolo'],
  interactionLevel: 'none' as const,
  pedagogicalGoal: 'Capire',
  reason: 'Serve',
  requiresDepiction: false,
  slotId: 'slot-1',
  title: 'Schema',
  visualDirection: 'Pulito',
  visualType: 'structural_svg' as const,
};

const result: LessonVisualWorkflowResult = {
  assetOwners: [],
  target: {
    contextFingerprint: buildLessonVisualContextFingerprint({
      lessonMarkdown: 'Lezione leggibile',
      sectionDescription: '',
      sectionTitle: 'Lezione',
    }),
    plan: retryPlan,
    projectId: 'project-1',
    sectionId: 'section-1',
    userId: 'user-1',
  },
  visual: {
    altText: 'Schema',
    anchorHeading: 'Titolo',
    createdAt: '2026-07-29T17:00:00.000Z',
    id: 'visual-slot-1',
    render: { code: '<svg></svg>', kind: 'svg' },
    slotId: 'slot-1',
    title: 'Schema',
  },
};

const retainedWarnings = [
  {
    code: 'lesson_pdf_image_extraction_incomplete',
    pageNumber: 2,
    sourceId: 'source-a',
    stage: 'sources',
  },
  {
    code: 'lesson_visual_generation_incomplete',
    stage: 'visuals',
    subjectId: 'slot-2',
  },
] as const;
const retriedVisualWarning = {
  code: 'lesson_visual_generation_incomplete',
  stage: 'visuals',
  subjectId: 'slot-1',
} as const;

const project = (section: Record<string, unknown>): ProjectSnapshot => ({
  createdAt: '2026-07-29T16:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-07-29T16:00:00.000Z',
  learningPlan: {
    modules: [{ children: [section], id: 'module-1', title: 'Modulo' }],
  },
  updatedAt: '2026-07-29T16:00:00.000Z',
  version: '4.1',
});

const failedSection = () => ({
  content: 'Lezione leggibile',
  contentBlocks: [
    { markdown: 'Lezione leggibile', type: 'markdown' },
    { retryPlan, slotId: 'slot-1', type: 'generated-visual' },
  ],
  generationWarnings: [...retainedWarnings, retriedVisualWarning],
  generatedVisuals: [
    {
      altText: 'Altro',
      createdAt: '2026-07-29T16:00:00.000Z',
      id: 'visual-other',
      render: { code: 'classDiagram', kind: 'mermaid' },
      slotId: 'other',
      title: 'Altro',
    },
  ],
  id: 'section-1',
  kind: 'lesson',
  title: 'Lezione',
  description: '',
});

describe('project lesson visual persistence', () => {
  test('commit replaces only the requested failed slot and preserves the rest of the lesson', () => {
    const patch = buildLessonVisualRetryCommitPatch(
      { revision: 4, snapshot: project(failedSection()) },
      result
    );

    expect(patch).toEqual({
      section: {
        contentBlocks: [
          { markdown: 'Lezione leggibile', type: 'markdown' },
          { slotId: 'slot-1', type: 'generated-visual', visualId: 'visual-slot-1' },
        ],
        generationWarnings: retainedWarnings,
        generatedVisuals: [expect.objectContaining({ id: 'visual-other' }), result.visual],
        sectionId: 'section-1',
      },
    });
  });

  test('undo restores the persisted retry plan and removes only its generated visual', () => {
    const committed = failedSection();
    committed.contentBlocks[1] = {
      slotId: 'slot-1',
      type: 'generated-visual',
      visualId: 'visual-slot-1',
    } as never;
    committed.generationWarnings = [...retainedWarnings];
    committed.generatedVisuals.push(result.visual as never);

    const patch = buildLessonVisualRetryUndoPatch(
      { revision: 5, snapshot: project(committed) },
      result
    );

    expect(patch.section).toEqual({
      contentBlocks: [
        { markdown: 'Lezione leggibile', type: 'markdown' },
        { retryPlan, slotId: 'slot-1', type: 'generated-visual' },
      ],
      generationWarnings: [...retainedWarnings, retriedVisualWarning],
      generatedVisuals: [expect.objectContaining({ id: 'visual-other' })],
      sectionId: 'section-1',
    });
  });

  test('undo is a no-op when the retry plan is already restored', () => {
    expect(
      buildLessonVisualRetryUndoPatch({ revision: 6, snapshot: project(failedSection()) }, result)
    ).toBeNull();
  });

  test('does not overwrite a newer visual that won the same slot', () => {
    const newer = failedSection();
    newer.contentBlocks[1] = {
      slotId: 'slot-1',
      type: 'generated-visual',
      visualId: 'visual-newer',
    } as never;

    expect(() =>
      buildLessonVisualRetryUndoPatch({ revision: 6, snapshot: project(newer) }, result)
    ).toThrow(ProjectLessonVisualTargetError);
  });

  test('does not persist a visual rendered from lesson context edited concurrently', () => {
    const edited = failedSection();
    edited.content = 'Lezione modificata mentre il visuale veniva generato';

    expect(() =>
      buildLessonVisualRetryCommitPatch({ revision: 6, snapshot: project(edited) }, result)
    ).toThrow(ProjectLessonVisualTargetError);
  });

  test('rejects missing or duplicate slot targets instead of guessing', () => {
    const missing = failedSection();
    missing.contentBlocks = missing.contentBlocks.slice(0, 1);
    const duplicate = failedSection();
    duplicate.contentBlocks.push({ retryPlan, slotId: 'slot-1', type: 'generated-visual' });

    expect(() =>
      buildLessonVisualRetryCommitPatch({ revision: 4, snapshot: project(missing) }, result)
    ).toThrow(ProjectLessonVisualTargetError);
    expect(() =>
      buildLessonVisualRetryCommitPatch({ revision: 4, snapshot: project(duplicate) }, result)
    ).toThrow(ProjectLessonVisualTargetError);
  });

  test('the adapter adopts and patches in the owning transactions', async () => {
    const transaction = {} as TransactionSql;
    const currentProject = { revision: 4, snapshot: project(failedSection()) };
    const adoptNodeAssets = vi.fn(async () => []);
    const patchProject = vi.fn(async (_transaction, request) => {
      request.buildPatch(currentProject);
      return {
        projectChanged: true,
        meta: { revision: 6 } as never,
        snapshot: currentProject.snapshot,
      };
    });
    const appendRevision = vi.fn(async () => undefined);
    const sql = {
      begin: vi.fn(async callback => callback(transaction)),
    } as never;
    const persistence = new PostgresLessonVisualPersistence({
      assets: { adoptNodeAssets },
      appendRevision,
      now: () => '2026-07-29T18:00:00.000Z',
      patchProject,
      sql,
    });
    const execution = {
      nodeInstanceId: 'root/persist-retry-result',
      runId: '11111111-1111-4111-8111-111111111111',
    };
    const firstAsset = {
      byteSize: 4,
      hash: 'a'.repeat(64),
      id: 'b'.repeat(64),
      mediaType: 'image/png',
    };
    const secondAsset = {
      byteSize: 5,
      hash: 'c'.repeat(64),
      id: 'd'.repeat(64),
      mediaType: 'image/webp',
    };
    const distributedResult: LessonVisualWorkflowResult = {
      ...result,
      assetOwners: [
        { assetIds: [firstAsset.id], nodeInstanceId: 'render-images/item:first' },
        { assetIds: [secondAsset.id], nodeInstanceId: 'render-images/item:second' },
      ],
      visual: {
        ...result.visual,
        render: {
          code: `<style></style><img src="{{PROJECT_ASSET:${firstAsset.id}}}"><img src="{{PROJECT_ASSET:${secondAsset.id}}}"><script></script>`,
          embeddedAssets: [firstAsset, secondAsset],
          kind: 'html',
        },
      },
    };

    await persistence.persistRetryResult({ execution, input: distributedResult, transaction });
    expect(adoptNodeAssets).toHaveBeenNthCalledWith(1, transaction, {
      assetIds: [firstAsset.id],
      nodeInstanceId: 'render-images/item:first',
      projectId: result.target.projectId,
      runId: execution.runId,
      userId: result.target.userId,
    });
    expect(adoptNodeAssets).toHaveBeenNthCalledWith(2, transaction, {
      assetIds: [secondAsset.id],
      nodeInstanceId: 'render-images/item:second',
      projectId: result.target.projectId,
      runId: execution.runId,
      userId: result.target.userId,
    });

    currentProject.snapshot = project({
      ...failedSection(),
      contentBlocks: [
        { markdown: 'Lezione leggibile', type: 'markdown' },
        { slotId: 'slot-1', type: 'generated-visual', visualId: result.visual.id },
      ],
      generatedVisuals: [result.visual],
    });
    await persistence.undoRetryResult({
      execution,
      idempotencyKey: 'undo-key',
      input: result,
      signal: new AbortController().signal,
    });
    expect(patchProject).toHaveBeenLastCalledWith(
      transaction,
      expect.objectContaining({ updatedAt: '2026-07-29T18:00:00.000Z' })
    );
    expect(appendRevision).toHaveBeenCalledWith(transaction, {
      eventType: 'lesson.project-revision',
      projectId: 'project-1',
      revision: 6,
      runId: execution.runId,
    });
  });

  test('does not publish another revision when a retried visual undo is already applied', async () => {
    const appendRevision = vi.fn(async () => undefined);
    const persistence = new PostgresLessonVisualPersistence({
      appendRevision,
      assets: { adoptNodeAssets: vi.fn(async () => []) },
      patchProject: vi.fn(async () => ({
        projectChanged: false,
        meta: { revision: 6 } as never,
        snapshot: project(failedSection()),
      })),
      sql: { begin: vi.fn(async callback => callback({} as TransactionSql)) } as never,
    });

    await persistence.undoRetryResult({
      execution: {
        nodeInstanceId: 'root/persist-retry-result',
        runId: '11111111-1111-4111-8111-111111111111',
      },
      idempotencyKey: 'undo-visual-retry',
      input: result,
      signal: new AbortController().signal,
    });

    expect(appendRevision).not.toHaveBeenCalled();
  });

  test('finalizes only the exact visual revision committed by the retry run', async () => {
    const committedSection = failedSection();
    committedSection.contentBlocks[1] = {
      slotId: 'slot-1',
      type: 'generated-visual',
      visualId: result.visual.id,
    } as never;
    committedSection.generatedVisuals.push(result.visual as never);
    const loadProjectWithRevision = vi.fn(async () => ({
      revision: 9,
      snapshot: project(committedSection),
    }));
    const finalize = createLessonVisualRetryFinalizer({ loadProjectWithRevision });

    await expect(
      finalize({
        execution: {
          nodeInstanceId: 'root/finalize-retry-result',
          runId: '11111111-1111-4111-8111-111111111111',
        },
        input: result,
      })
    ).resolves.toEqual({ ...result, projectRevision: 9 });
    expect(loadProjectWithRevision).toHaveBeenCalledWith('user-1', 'project-1');

    committedSection.generatedVisuals = [];
    await expect(
      finalize({
        execution: {
          nodeInstanceId: 'root/finalize-retry-result',
          runId: '11111111-1111-4111-8111-111111111111',
        },
        input: result,
      })
    ).rejects.toMatchObject({ failure: { code: 'lesson_visual_retry_commit_changed' } });
  });
});
