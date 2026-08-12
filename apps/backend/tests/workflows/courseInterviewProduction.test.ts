import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { createCourseGenerationWorkflow } from '../../src/workflows/courseGenerationWorkflow.js';
import { createProductionCourseInterviewServices } from '../../src/workflows/courseInterviewProduction.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';

const cleanupInput = {
  execution: { nodeInstanceId: 'cleanup', runId: 'interview-1' },
  idempotencyKey: 'cleanup-key',
  projectId: 'project-1',
  signal: new AbortController().signal,
  userId: 'user-1',
};

const createDependencies = () => {
  const projectStore = {
    deleteProject: vi.fn().mockResolvedValue(undefined),
    loadProject: vi.fn().mockResolvedValue({ id: 'project-1' }),
    patchProject: vi.fn().mockResolvedValue({}),
  };
  const patchProject = vi.fn().mockResolvedValue({});
  const runStore = {
    createRun: vi.fn(),
    getActiveRun: vi.fn().mockResolvedValue(null),
  };
  return { patchProject, projectStore, registry: createWorkflowRegistry(), runStore };
};

describe('production course interview services', () => {
  test('never deletes a draft claimed by an active course generation', async () => {
    const dependencies = createDependencies();
    dependencies.runStore.getActiveRun.mockResolvedValue({ id: 'generation-1' });
    const services = createProductionCourseInterviewServices(dependencies);

    await services.discardUnclaimedDraftProject(cleanupInput);

    expect(dependencies.projectStore.loadProject).not.toHaveBeenCalled();
    expect(dependencies.projectStore.deleteProject).not.toHaveBeenCalled();
  });

  test('keeps a project already claimed by a completed generation marker', async () => {
    const dependencies = createDependencies();
    dependencies.projectStore.loadProject.mockResolvedValue({
      id: 'project-1',
      lastCourseGenerationRunId: 'generation-1',
    });
    const services = createProductionCourseInterviewServices(dependencies);

    await services.discardUnclaimedDraftProject(cleanupInput);

    expect(dependencies.projectStore.deleteProject).not.toHaveBeenCalled();
  });

  test('never deletes an existing course without a generation marker', async () => {
    const dependencies = createDependencies();
    dependencies.projectStore.loadProject.mockResolvedValue({
      id: 'project-1',
      learningPlan: { title: 'Corso legacy' },
    });
    const services = createProductionCourseInterviewServices(dependencies);

    await services.discardUnclaimedDraftProject(cleanupInput);

    expect(dependencies.projectStore.deleteProject).not.toHaveBeenCalled();
  });

  test('deletes only an unclaimed interview draft', async () => {
    const dependencies = createDependencies();
    const services = createProductionCourseInterviewServices(dependencies);

    await services.discardUnclaimedDraftProject(cleanupInput);

    expect(dependencies.projectStore.deleteProject).toHaveBeenCalledWith('user-1', 'project-1');
  });

  test('makes repeated draft cleanup harmless after the first deletion', async () => {
    const dependencies = createDependencies();
    dependencies.projectStore.loadProject
      .mockResolvedValueOnce({ id: 'project-1' })
      .mockResolvedValueOnce(null);
    const services = createProductionCourseInterviewServices(dependencies);

    await services.discardUnclaimedDraftProject(cleanupInput);
    await services.discardUnclaimedDraftProject(cleanupInput);

    expect(dependencies.projectStore.deleteProject).toHaveBeenCalledTimes(1);
  });

  test('persists the complete profile and learn-mode flag', async () => {
    const dependencies = createDependencies();
    const services = createProductionCourseInterviewServices(dependencies);
    const profile = {
      context: 'Contesto',
      experienceLevel: 'Intermediate',
      goals: 'Obiettivi',
      language: 'Italiano',
      learningStyle: 'Practical',
      topic: 'Sistemi distribuiti',
    };

    await services.saveCourseProfile({
      mode: 'learn',
      profile,
      projectId: cleanupInput.projectId,
      transaction: {} as never,
      userId: cleanupInput.userId,
    });

    expect(dependencies.patchProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        buildPatch: expect.any(Function),
        projectId: 'project-1',
        userId: 'user-1',
      })
    );
    expect(dependencies.patchProject.mock.calls[0]?.[1].buildPatch()).toEqual({
      isLearnMode: true,
      state: 'ASSESSMENT',
      userProfile: profile,
    });
  });

  test('keeps the separate profile patch available only for legacy run resumption', async () => {
    const dependencies = createDependencies();
    const services = createProductionCourseInterviewServices(dependencies);
    const profile = {
      context: 'Contesto',
      experienceLevel: 'Intermediate',
      goals: 'Obiettivi',
      language: 'Italiano',
      learningStyle: 'Practical',
      topic: 'Sistemi distribuiti',
    };

    await services.saveCourseProfileBeforeCheckpoint({
      execution: cleanupInput.execution,
      idempotencyKey: 'legacy-profile',
      mode: 'learn',
      profile,
      projectId: cleanupInput.projectId,
      signal: cleanupInput.signal,
      userId: cleanupInput.userId,
    });

    expect(dependencies.projectStore.patchProject).toHaveBeenCalledWith(
      'user-1',
      'project-1',
      expect.objectContaining({
        isLearnMode: true,
        state: 'ASSESSMENT',
        userProfile: profile,
      })
    );
  });

  test('starts the child with the frozen interview models', async () => {
    const dependencies = createDependencies();
    const models = getGlobalModelConfig();
    dependencies.registry.register({
      current: createCourseGenerationWorkflow({
        maxAttempts: 3,
        models,
        timeoutMs: 60_000,
      }),
    });
    dependencies.runStore.createRun.mockResolvedValue({
      created: true,
      run: { id: 'generation-1' },
    });
    const services = createProductionCourseInterviewServices(dependencies);

    const result = await services.startCourseGeneration({
      assessmentHistory: [{ role: 'user', text: 'Voglio imparare.' }],
      idempotencyKey: 'generation-key',
      mode: 'learn',
      models,
      projectId: 'project-1',
      signal: new AbortController().signal,
      userId: 'user-1',
    });

    expect(result).toEqual({ runId: 'generation-1' });
    expect(dependencies.runStore.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ models }),
        requestKey: 'generation-key',
        workflowId: 'course-generation',
      })
    );
  });
});
