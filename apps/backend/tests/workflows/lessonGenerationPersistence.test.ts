import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { applyProjectPatch } from '../../src/projects/projectPatch.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import {
  buildLessonGenerationSourceFingerprint,
  buildLessonGenerationTargetFingerprint,
} from '../../src/workflows/lessonGenerationAuthority.js';
import {
  buildLessonGenerationCommitPatch,
  buildLessonGenerationUndoPatch,
  buildSublessonCommitPatch,
  buildSublessonUndoPatch,
  createLessonPersistenceStage,
  createLessonResultFinalizer,
  PostgresLessonGenerationPersistence,
  ProjectLessonGenerationTargetError,
} from '../../src/workflows/lessonGenerationPersistence.js';
import {
  LessonVisualsStateSchema,
  SublessonReadyStateSchema,
} from '../../src/workflows/lessonGenerationWorkflowContract.js';

const NOW = '2026-07-29T22:30:00.000Z';
const PDF_ASSET_ID = 'a'.repeat(64);
const UNUSED_PDF_ASSET_ID = 'b'.repeat(64);
const VISUAL_ASSET_ID = 'c'.repeat(64);
const UNUSED_VISUAL_ASSET_ID = 'd'.repeat(64);
const OTHER_ASSET_ID = 'e'.repeat(64);

const asset = (id: string) => ({
  byteSize: 5,
  hash: id,
  id,
  mediaType: 'image/png',
});

const project = (): ProjectSnapshot => ({
  createdAt: '2026-07-29T20:00:00.000Z',
  documentAssets: {
    imageCount: 2,
    kind: 'pdf',
    parsedAt: '2026-07-29T20:00:00.000Z',
    usedImages: [
      {
        asset: asset('f'.repeat(64)),
        id: 'pdf-old',
        sourceOrder: 1,
        textAfter: '',
        textBefore: '',
      },
      {
        asset: asset(OTHER_ASSET_ID),
        id: 'pdf-other',
        sourceOrder: 2,
        textAfter: '',
        textBefore: '',
      },
    ],
  },
  id: 'project-1',
  lastOpenedAt: '2026-07-29T20:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [
          {
            content: 'Lezione precedente',
            contentBlocks: [{ markdown: 'Lezione precedente', type: 'markdown' }],
            description: 'Descrizione',
            id: 'lesson-1',
            imageRefs: [{ alt: 'Vecchia', assetId: 'pdf-old' }],
            kind: 'lesson',
            lastGenerationRunId: 'run-old',
            learningAids: [],
            quiz: [],
            title: 'Lezione',
          },
          {
            id: 'lesson-2',
            imageRefs: [{ alt: 'Altra', assetId: 'pdf-other' }],
            kind: 'lesson',
            title: 'Altra lezione',
          },
        ],
        id: 'module-1',
        title: 'Modulo',
      },
    ],
    title: 'Corso',
  },
  researchDossiersBySectionId: {
    'lesson-1': { customMetadata: 'preserve-me', sectionId: 'lesson-1' },
    'lesson-2': { customMetadata: 'concurrent-dossier', sectionId: 'lesson-2' },
  },
  source: { kind: 'document', ref: { hash: '1'.repeat(64), id: 'source-1' } },
  sourceKind: 'document',
  updatedAt: '2026-07-29T20:00:00.000Z',
  userProfile: { language: 'Italiano' },
  version: '4.1',
});

const visualsState = (snapshot: ProjectSnapshot) =>
  LessonVisualsStateSchema.parse({
    content: '## Lezione\n\nContenuto nuovo.',
    contentBlocks: [
      { markdown: '## Lezione\n\nContenuto nuovo.', type: 'markdown' },
      { slotId: 'visual-1', type: 'generated-visual', visualId: 'visual-1' },
    ],
    discoveredYoutubeSources: [],
    documentAssetOwners: [
      {
        assetIds: [PDF_ASSET_ID, UNUSED_PDF_ASSET_ID],
        nodeInstanceId: 'root/stage-document-sources',
      },
    ],
    documentAssets: {
      imageCount: 1,
      kind: 'pdf',
      parsedAt: NOW,
      usedImages: [
        {
          asset: asset(PDF_ASSET_ID),
          id: 'pdf-new',
          sourceOrder: 1,
          textAfter: '',
          textBefore: '',
        },
      ],
    },
    documentSourceHash: '1'.repeat(64),
    draft: {
      contentBlocks: [{ markdown: '## Lezione\n\nContenuto nuovo.', type: 'markdown' }],
      generatedVisuals: [],
      imageRefs: [],
    },
    existingDossierJson: JSON.stringify(snapshot.researchDossiersBySectionId?.['lesson-1']),
    existingSources: [],
    generatedVisuals: [
      {
        createdAt: NOW,
        id: 'visual-1',
        render: { asset: asset(VISUAL_ASSET_ID), kind: 'image' },
        slotId: 'visual-1',
      },
    ],
    imageRefs: [{ alt: 'Nuova', assetId: 'pdf-new' }],
    learningAids: [],
    lessonInputData: {
      description: 'Descrizione',
      imageCandidates: [],
      instructionPacks: [],
      language: 'Italiano',
      pedagogicalContext: '',
      previousLessonTitles: [],
      sectionTitle: 'Lezione',
      sourceContext: 'Fonte originale',
    },
    lessonSources: [],
    originalSources: [],
    pdfImages: [],
    quiz: [],
    request: {
      forceRegenerate: true,
      projectId: 'project-1',
      sectionId: 'lesson-1',
      userId: 'user-1',
    },
    requiresCoverageAssessment: false,
    research: {
      context: '',
      summary: {
        avoidOversimplifying: [],
        controversies: [],
        difficultSteps: [],
        factualSummary: 'Sintesi verificata.',
        keyExamples: [],
        recentDevelopments: [],
        sources: [],
      },
      youtube: null,
    },
    sourceFingerprint: buildLessonGenerationSourceFingerprint(snapshot, 'lesson-1'),
    stage: 'visuals',
    targetFingerprint: buildLessonGenerationTargetFingerprint(snapshot, 'lesson-1'),
    visualAssetOwners: [
      {
        assetIds: [VISUAL_ASSET_ID, UNUSED_VISUAL_ASSET_ID],
        nodeInstanceId: 'root/render-visuals/item:visual-1/render',
      },
    ],
    visualPlanningDecision: {
      initial: { outcome: 'none', plans: [], rationale: 'Nessun altro visuale.' },
      reviewed: { outcome: 'none', plans: [], rationale: 'Nessun altro visuale.' },
      reviewedAt: NOW,
    },
    warnings: [],
    youtubePlanning: { courseTitle: 'Corso', keyConcepts: [] },
  });

const context = (input: ReturnType<typeof visualsState>) => ({
  attemptNumber: 1,
  config: {} as never,
  execution: { nodeInstanceId: 'root/persist-lesson', runId: 'run-new' },
  idempotencyKey: 'persist-key',
  input,
  retryFeedback: '',
  signal: new AbortController().signal,
});

describe('durable lesson generation persistence', () => {
  test('inserts a sublesson after the complete parent subtree and removes it on undo', () => {
    const snapshot = project();
    snapshot.activeSectionId = 'lesson-1';
    const module = snapshot.learningPlan?.modules?.[0];
    if (!module?.children) throw new Error('Missing test module.');
    module.children.splice(1, 0, {
      id: 'lesson-1-child',
      kind: 'lesson',
      parentId: 'lesson-1',
      title: 'Approfondimento esistente',
    });
    module.children.push({ id: 'exercise-1', kind: 'exercise', title: 'Laboratorio' });
    const state = SublessonReadyStateSchema.parse({
      createdDocumentIndex: null,
      parentSectionId: 'lesson-1',
      previousActiveSectionId: 'lesson-1',
      projectRevision: 4,
      request: {
        forceRegenerate: false,
        projectId: 'project-1',
        sectionId: 'sublesson-1',
        userId: 'user-1',
      },
      section: {
        contextPrompt: 'Approfondisci.',
        description: 'Nuovo approfondimento.',
        id: 'sublesson-1',
        isCompleted: false,
        kind: 'lesson',
        parentId: 'lesson-1',
        title: 'Nuovo approfondimento',
        type: 'deep-dive',
      },
      stage: 'sublesson-ready',
    });

    const commitPatch = buildSublessonCommitPatch({ revision: 4, snapshot }, state);
    const committed = applyProjectPatch(snapshot, commitPatch, NOW);
    const ids = committed.learningPlan?.modules?.[0]?.children?.map(child => child.id);
    expect(ids).toEqual(['lesson-1', 'lesson-1-child', 'sublesson-1', 'lesson-2', 'exercise-1']);
    expect(committed.activeSectionId).toBe('sublesson-1');

    const undoPatch = buildSublessonUndoPatch(committed, state);
    const restored = applyProjectPatch(committed, undoPatch ?? {}, NOW);
    expect(restored.learningPlan?.modules?.[0]?.children?.map(child => child.id)).toEqual([
      'lesson-1',
      'lesson-1-child',
      'lesson-2',
      'exercise-1',
    ]);
    expect(restored.activeSectionId).toBe('lesson-1');
    expect(buildSublessonUndoPatch(restored, state)).toBeNull();

    const changed = structuredClone(committed);
    const inserted = changed.learningPlan?.modules?.[0]?.children?.find(
      child => child.id === 'sublesson-1'
    );
    if (!inserted) throw new Error('Missing inserted sublesson.');
    inserted.title = 'Modifica concorrente';
    expect(() => buildSublessonUndoPatch(changed, state)).toThrow(
      ProjectLessonGenerationTargetError
    );
  });

  test('captures the previous target and builds a deterministic dossier before the transaction', async () => {
    const snapshot = project();
    const stage = createLessonPersistenceStage({
      loadProject: vi.fn().mockResolvedValue(snapshot),
      now: () => NOW,
    });

    const state = await stage(context(visualsState(snapshot)));

    expect(state.persistedAt).toBe(NOW);
    expect(JSON.parse(state.previous.sectionJson)).toMatchObject({
      content: 'Lezione precedente',
      lastGenerationRunId: 'run-old',
    });
    expect(state.result.researchDossier).toMatchObject({
      factualSummary: 'Sintesi verificata.',
      generatedAt: NOW,
      sectionId: 'lesson-1',
    });
    expect(state.committedTargetFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('commits atomically and adopts only assets referenced by the final lesson', async () => {
    const snapshot = project();
    const input = visualsState(snapshot);
    input.warnings = [
      {
        code: 'lesson_pdf_image_extraction_incomplete',
        pageNumber: 4,
        sourceId: 'source-1',
        stage: 'sources',
      },
    ];
    const state = await createLessonPersistenceStage({
      loadProject: vi.fn().mockResolvedValue(snapshot),
      now: () => NOW,
    })(context(input));
    const transaction = {} as TransactionSql;
    const adoptNodeAssets = vi.fn(async () => []);
    const patchProject = vi.fn(async (_transaction, request) => ({
      meta: {} as never,
      snapshot: applyProjectPatch(snapshot, request.buildPatch({ revision: 4, snapshot }), NOW),
    }));
    const persistence = new PostgresLessonGenerationPersistence({
      assets: { adoptNodeAssets },
      patchProject,
      sql: { begin: vi.fn() } as never,
    });

    await persistence.persistLesson({
      execution: context(input).execution,
      input,
      output: state,
      transaction,
    });

    expect(patchProject).toHaveBeenCalledOnce();

    expect(adoptNodeAssets).toHaveBeenNthCalledWith(1, transaction, {
      assetIds: [PDF_ASSET_ID],
      nodeInstanceId: 'root/stage-document-sources',
      projectId: 'project-1',
      runId: 'run-new',
      userId: 'user-1',
    });
    expect(adoptNodeAssets).toHaveBeenNthCalledWith(2, transaction, {
      assetIds: [VISUAL_ASSET_ID],
      nodeInstanceId: 'root/render-visuals/item:visual-1/render',
      projectId: 'project-1',
      runId: 'run-new',
      userId: 'user-1',
    });
    const patch = buildLessonGenerationCommitPatch(
      { revision: 4, snapshot },
      input,
      state,
      context(input).execution
    );
    expect(patch.documentAssets).toMatchObject({
      usedImages: [
        expect.objectContaining({ id: 'pdf-new' }),
        expect.objectContaining({ id: 'pdf-other' }),
      ],
    });
    expect(patch.section).toMatchObject({
      content: input.content,
      generationWarnings: input.warnings,
      lastGenerationRunId: 'run-new',
      sectionId: 'lesson-1',
    });
    expect(patch.researchDossiersBySectionId?.['lesson-1']).toMatchObject({
      customMetadata: 'preserve-me',
      factualSummary: 'Sintesi verificata.',
    });
    expect(patch.researchDossiersBySectionId?.['lesson-2']).toEqual({
      customMetadata: 'concurrent-dossier',
      sectionId: 'lesson-2',
    });
  });

  test('finalizes the public result from the committed global project state and revision', async () => {
    const snapshot = project();
    const input = visualsState(snapshot);
    const execution = context(input).execution;
    const state = await createLessonPersistenceStage({
      loadProject: vi.fn().mockResolvedValue(snapshot),
      now: () => NOW,
    })(context(input));
    const committed = applyProjectPatch(
      snapshot,
      buildLessonGenerationCommitPatch({ revision: 4, snapshot }, input, state, execution),
      NOW
    );
    const finalize = createLessonResultFinalizer({
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 5, snapshot: committed }),
    });

    const result = await finalize({ ...context(input), input: state });

    expect(result.projectRevision).toBe(5);
    expect(result.documentAssets?.usedImages.map(image => image.id)).toEqual([
      'pdf-new',
      'pdf-other',
    ]);
  });

  test('rejects source or generated-target changes instead of overwriting them', async () => {
    const snapshot = project();
    const input = visualsState(snapshot);
    const state = await createLessonPersistenceStage({
      loadProject: vi.fn().mockResolvedValue(snapshot),
      now: () => NOW,
    })(context(input));
    const editedSource = structuredClone(snapshot);
    const editedSourceLesson = editedSource.learningPlan?.modules?.[0]?.children?.[0];
    if (!editedSourceLesson) throw new Error('Missing source test lesson.');
    editedSourceLesson.description = 'Descrizione aggiornata';
    const editedTarget = structuredClone(snapshot);
    const editedTargetLesson = editedTarget.learningPlan?.modules?.[0]?.children?.[0];
    if (!editedTargetLesson) throw new Error('Missing target test lesson.');
    editedTargetLesson.content = 'Modifica concorrente';
    const removedTarget = structuredClone(snapshot);
    const targetModule = removedTarget.learningPlan?.modules?.[0];
    if (!targetModule) throw new Error('Missing target list.');
    targetModule.children = targetModule.children.filter(lesson => lesson.id !== 'lesson-1');

    expect(() =>
      buildLessonGenerationCommitPatch(
        { revision: 5, snapshot: editedSource },
        input,
        state,
        context(input).execution
      )
    ).toThrow(ProjectLessonGenerationTargetError);
    expect(() =>
      buildLessonGenerationCommitPatch(
        { revision: 5, snapshot: editedTarget },
        input,
        state,
        context(input).execution
      )
    ).toThrow(ProjectLessonGenerationTargetError);
    expect(() =>
      buildLessonGenerationCommitPatch(
        { revision: 5, snapshot: removedTarget },
        input,
        state,
        context(input).execution
      )
    ).toThrow(ProjectLessonGenerationTargetError);
  });

  test('undo restores the prior lesson without clobbering other lesson assets and is idempotent', async () => {
    const snapshot = project();
    const input = visualsState(snapshot);
    const execution = context(input).execution;
    const state = await createLessonPersistenceStage({
      loadProject: vi.fn().mockResolvedValue(snapshot),
      now: () => NOW,
    })(context(input));
    const committed = applyProjectPatch(
      snapshot,
      buildLessonGenerationCommitPatch({ revision: 4, snapshot }, input, state, execution),
      NOW
    );

    const undoPatch = buildLessonGenerationUndoPatch(
      { revision: 5, snapshot: committed },
      input,
      state,
      execution
    );
    expect(undoPatch).not.toBeNull();
    const restored = applyProjectPatch(committed, undoPatch ?? {}, NOW);
    expect(buildLessonGenerationTargetFingerprint(restored, 'lesson-1')).toBe(
      input.targetFingerprint
    );
    expect(restored.documentAssets).toMatchObject({
      usedImages: [
        expect.objectContaining({ id: 'pdf-old' }),
        expect.objectContaining({ id: 'pdf-other' }),
      ],
    });
    expect(
      buildLessonGenerationUndoPatch({ revision: 6, snapshot: restored }, input, state, execution)
    ).toBeNull();

    const overwritten = structuredClone(committed);
    const overwrittenLesson = overwritten.learningPlan?.modules?.[0]?.children?.[0];
    if (!overwrittenLesson) throw new Error('Missing overwritten test lesson.');
    overwrittenLesson.content = 'Risultato di un altro processo';
    expect(() =>
      buildLessonGenerationUndoPatch(
        { revision: 6, snapshot: overwritten },
        input,
        state,
        execution
      )
    ).toThrow(ProjectLessonGenerationTargetError);
  });

  test('appends the restored lesson revision inside the undo transaction', async () => {
    const snapshot = project();
    const input = visualsState(snapshot);
    const output = await createLessonPersistenceStage({
      loadProject: vi.fn().mockResolvedValue(snapshot),
      now: () => NOW,
    })(context(input));
    const transaction = {} as TransactionSql;
    const appendRevision = vi.fn(async () => undefined);
    const patchProject = vi.fn(async () => ({
      projectChanged: true,
      meta: { revision: 6 } as never,
      snapshot,
    }));
    const persistence = new PostgresLessonGenerationPersistence({
      appendRevision,
      assets: { adoptNodeAssets: vi.fn(async () => []) },
      patchProject,
      sql: {
        begin: vi.fn(async callback => callback(transaction)),
      } as never,
    });

    await persistence.undoLesson({
      execution: context(input).execution,
      idempotencyKey: 'undo-lesson',
      input,
      output,
      signal: new AbortController().signal,
    });

    expect(appendRevision).toHaveBeenCalledWith(transaction, {
      eventType: 'lesson.project-revision',
      projectId: 'project-1',
      revision: 6,
      runId: 'run-new',
    });
    expect(patchProject.mock.invocationCallOrder[0]).toBeLessThan(
      appendRevision.mock.invocationCallOrder[0] as number
    );
  });

  test('does not publish another revision when a retried lesson undo is already applied', async () => {
    const snapshot = project();
    const input = visualsState(snapshot);
    const output = await createLessonPersistenceStage({
      loadProject: vi.fn().mockResolvedValue(snapshot),
      now: () => NOW,
    })(context(input));
    const appendRevision = vi.fn(async () => undefined);
    const persistence = new PostgresLessonGenerationPersistence({
      appendRevision,
      assets: { adoptNodeAssets: vi.fn(async () => []) },
      patchProject: vi.fn(async () => ({
        projectChanged: false,
        meta: { revision: 6 } as never,
        snapshot,
      })),
      sql: { begin: vi.fn(async callback => callback({} as TransactionSql)) } as never,
    });

    await persistence.undoLesson({
      execution: context(input).execution,
      idempotencyKey: 'undo-lesson-retry',
      input,
      output,
      signal: new AbortController().signal,
    });

    expect(appendRevision).not.toHaveBeenCalled();
  });
});
