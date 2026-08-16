import { describe, expect, test, vi } from 'vitest';

import type { ProjectSnapshot } from '../../src/projects/types.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import { buildLessonVisualContextFingerprint } from '../../src/workflows/lessonVisualContext.js';
import {
  createLessonVisualRetryStarter,
  LessonVisualRetryTargetError,
} from '../../src/workflows/lessonVisualRetryStart.js';
import { createLessonVisualWorkflows } from '../../src/workflows/lessonVisualWorkflow.js';
import type { CreateWorkflowRunInput } from '../../src/workflows/persistence/postgresWorkflowStore.js';
import type { WorkflowRun } from '../../src/workflows/types.js';

const visualConfig = {
  artifact: { model: 'artifact', provider: 'openrouter' as const, reasoningEffort: 'low' as const },
  artifactInteractive: {
    model: 'interactive',
    provider: 'codex' as const,
    reasoningEffort: 'low' as const,
  },
  image: { model: 'image', provider: 'openrouter' as const },
  review: { enabled: true, maxRounds: 1 },
};

const retryPlan = {
  altText: 'Struttura di trama e ordito',
  anchorHeading: 'Intreccio',
  complexity: 'moderate' as const,
  concept: 'Intreccio di trama e ordito',
  coverage: 'complete_synthesis' as const,
  coverageRationale: 'Mostra la struttura.',
  factualRequirements: ['Fili perpendicolari'],
  interactionLevel: 'low' as const,
  pedagogicalGoal: 'Riconoscere l intreccio',
  reason: 'Confronto visivo',
  requiresDepiction: false,
  slotId: 'slot-1',
  title: 'Trama e ordito',
  visualDirection: 'Schema ordinato',
  visualType: 'structural_svg' as const,
};

const project = {
  createdAt: '2026-07-29T10:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-07-29T10:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [
          {
            content: '## Intreccio\n\nTrama e ordito si incrociano.',
            contentBlocks: [
              { markdown: '## Intreccio\n\nTrama e ordito si incrociano.', type: 'markdown' },
              { retryPlan, slotId: 'slot-1', type: 'generated-visual' },
            ],
            description: 'Riconoscere trama e ordito.',
            generatedVisuals: [],
            id: 'section-1',
            kind: 'lesson',
            title: 'Intreccio',
          },
        ],
        id: 'module-1',
      },
    ],
  },
  updatedAt: '2026-07-29T10:00:00.000Z',
  version: '1',
};

const createRunResult = (input: CreateWorkflowRunInput): WorkflowRun => ({
  cancellationRequested: false,
  cleanupStatus: 'not-required',
  createdAt: '2026-07-29T10:01:00.000Z',
  definitionHash: input.definitionHash,
  definitionHashVersion: input.definitionHashVersion,
  id: input.id,
  input: input.input,
  projectId: input.projectId,
  requestKey: input.requestKey,
  resolvedConfig: input.config,
  status: 'queued',
  stepPolicies: input.materialization.stepPolicies,
  stepPoliciesVersion: input.materialization.stepPoliciesVersion,
  updatedAt: '2026-07-29T10:01:00.000Z',
  userId: input.userId,
  workflowId: input.workflowId,
});

const makeStarter = (projectSnapshot: ProjectSnapshot | null = project) => {
  const registry = createWorkflowRegistry();
  const workflows = createLessonVisualWorkflows({
    maxAttempts: 3,
    timeoutMs: 60_000,
    visual: visualConfig,
  });
  registry.register({ current: workflows.retry });
  const createRun = vi.fn(async (input: CreateWorkflowRunInput) => ({
    created: true,
    run: createRunResult(input),
  }));
  const getRunByRequestKey = vi.fn(async () => null as WorkflowRun | null);
  const loadProject = vi.fn(async () => projectSnapshot);
  const resolveVisualConfig = vi.fn(async () => visualConfig);
  return {
    createRun,
    getRunByRequestKey,
    loadProject,
    resolveVisualConfig,
    starter: createLessonVisualRetryStarter({
      projectReader: { loadProject },
      registry,
      resolveVisualConfig,
      store: { createRun, getRunByRequestKey },
    }),
  };
};

describe('lesson visual retry start', () => {
  test('starts from the authoritative project snapshot with frozen model resolution', async () => {
    const { createRun, loadProject, resolveVisualConfig, starter } = makeStarter();

    const result = await starter.start({
      aiProvider: 'codex',
      aiProviderOverrides: { artifact: 'openrouter' },
      projectId: 'project-1',
      requestKey: 'retry-click-1',
      sectionId: 'section-1',
      slotId: 'slot-1',
      userId: 'user-1',
    });

    expect(result.created).toBe(true);
    expect(loadProject).toHaveBeenCalledWith('user-1', 'project-1');
    expect(resolveVisualConfig).toHaveBeenCalledWith({
      aiProvider: 'codex',
      aiProviderOverrides: { artifact: 'openrouter' },
    });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: JSON.stringify(['retry-lesson-visual', 'project-1', 'section-1', 'slot-1']),
        input: {
          contextFingerprint: buildLessonVisualContextFingerprint({
            lessonMarkdown: '## Intreccio\n\nTrama e ordito si incrociano.',
            sectionDescription: 'Riconoscere trama e ordito.',
            sectionTitle: 'Intreccio',
          }),
          lessonMarkdown: '## Intreccio\n\nTrama e ordito si incrociano.',
          plan: retryPlan,
          projectId: 'project-1',
          sectionDescription: 'Riconoscere trama e ordito.',
          sectionId: 'section-1',
          sectionTitle: 'Intreccio',
          userId: 'user-1',
        },
        projectId: 'project-1',
        requestKey: 'retry-click-1',
        userId: 'user-1',
        workflowId: 'retry-lesson-visual',
      })
    );
    const persistedConfig = createRun.mock.calls[0]?.[0].config;
    expect(persistedConfig).toEqual({ maxAttempts: 3, timeoutMs: 60_000, visual: visualConfig });
  });

  test('rejects a missing, completed, or ambiguous slot before resolving a provider', async () => {
    const cases = [
      [],
      [{ slotId: 'slot-1', type: 'generated-visual', visualId: 'visual-slot-1' }],
      [
        { retryPlan, slotId: 'slot-1', type: 'generated-visual' },
        { retryPlan, slotId: 'slot-1', type: 'generated-visual' },
      ],
    ];

    for (const contentBlocks of cases) {
      const snapshot = structuredClone(project);
      const section = snapshot.learningPlan.modules[0]?.children[0];
      if (!section) throw new Error('Expected the test lesson.');
      section.contentBlocks = contentBlocks;
      const { resolveVisualConfig, starter } = makeStarter(snapshot);

      await expect(
        starter.start({
          projectId: 'project-1',
          requestKey: 'retry-click-1',
          sectionId: 'section-1',
          slotId: 'slot-1',
          userId: 'user-1',
        })
      ).rejects.toBeInstanceOf(LessonVisualRetryTargetError);
      expect(resolveVisualConfig).not.toHaveBeenCalled();
    }
  });

  test('starts historical retries without presentation metadata that was never persisted', async () => {
    const {
      altText: _altText,
      anchorHeading: _anchorHeading,
      title: _title,
      ...historicalRetryPlan
    } = retryPlan;
    const historicalProject: ProjectSnapshot = {
      ...project,
      learningPlan: {
        modules: [
          {
            children: [
              {
                ...project.learningPlan.modules[0]?.children[0],
                contentBlocks: [
                  {
                    retryPlan: historicalRetryPlan,
                    slotId: historicalRetryPlan.slotId,
                    type: 'generated-visual',
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const { createRun, starter } = makeStarter(historicalProject);

    await expect(
      starter.start({
        projectId: 'project-1',
        requestKey: 'retry-historical-1',
        sectionId: 'section-1',
        slotId: 'slot-1',
        userId: 'user-1',
      })
    ).resolves.toMatchObject({ created: true });
    expect(createRun.mock.calls[0]?.[0].input).toMatchObject({ plan: historicalRetryPlan });
  });

  test('replays a consumed retry slot only after store identity validation', async () => {
    const consumedProject: ProjectSnapshot = structuredClone(project);
    const { createRun, getRunByRequestKey, loadProject, resolveVisualConfig, starter } =
      makeStarter(consumedProject);
    const request = {
      projectId: 'project-1',
      requestKey: 'retry-click-replayed',
      sectionId: 'section-1',
      slotId: 'slot-1',
      userId: 'user-1',
    };
    const started = await starter.start(request);
    const retryBlock = consumedProject.learningPlan.modules[0]?.children[0]?.contentBlocks?.[1];
    if (!retryBlock || retryBlock.type !== 'generated-visual') {
      throw new Error('Expected the retry block.');
    }
    retryBlock.visualId = 'lesson-visual:existing';
    getRunByRequestKey.mockResolvedValueOnce(started.run);
    createRun.mockResolvedValueOnce({ created: false, run: started.run });

    await expect(starter.start(request)).resolves.toEqual({ created: false, run: started.run });
    expect(getRunByRequestKey).toHaveBeenCalledWith({
      requestKey: request.requestKey,
      userId: request.userId,
      workflowId: 'retry-lesson-visual',
    });
    expect(createRun).toHaveBeenCalledTimes(2);
    expect(loadProject).toHaveBeenCalledTimes(2);
    expect(resolveVisualConfig).toHaveBeenCalledTimes(2);
  });

  test('never replays a request key for a different visual target before store validation', async () => {
    const projectWithTwoLessons = structuredClone(project);
    const firstSection = projectWithTwoLessons.learningPlan.modules[0]?.children[0];
    if (!firstSection) throw new Error('Expected the first lesson.');
    projectWithTwoLessons.learningPlan.modules[0]?.children.push({
      ...structuredClone(firstSection),
      id: 'section-2',
    });
    const { createRun, getRunByRequestKey, starter } = makeStarter(projectWithTwoLessons);
    const first = await starter.start({
      projectId: 'project-1',
      requestKey: 'retry-click-shared',
      sectionId: 'section-1',
      slotId: 'slot-1',
      userId: 'user-1',
    });
    const storeConflict = new Error('store rejected the mismatched request fingerprint');
    getRunByRequestKey.mockResolvedValueOnce(first.run);
    createRun.mockRejectedValueOnce(storeConflict);

    await expect(
      starter.start({
        projectId: 'project-1',
        requestKey: 'retry-click-shared',
        sectionId: 'section-2',
        slotId: 'slot-1',
        userId: 'user-1',
      })
    ).rejects.toBe(storeConflict);
    expect(createRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ sectionId: 'section-2' }),
        projectId: 'project-1',
        requestKey: 'retry-click-shared',
      })
    );
  });
});
