import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { createCourseGenerationStarter } from '../../src/workflows/courseGenerationStart.js';
import { createCourseGenerationWorkflow } from '../../src/workflows/courseGenerationWorkflow.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';

const models = getGlobalModelConfig();
const config = {
  maxAttempts: 3,
  models,
  timeoutMs: 600_000,
};

describe('course generation workflow start', () => {
  test('freezes resolved models and shares one active-work identity per project', async () => {
    const registry = createWorkflowRegistry();
    registry.register({ current: createCourseGenerationWorkflow(config) });
    const createRun = vi.fn().mockResolvedValue({
      created: true,
      run: { id: 'run-1', status: 'queued' },
    });
    const resolveModels = vi.fn().mockResolvedValue(models);
    const starter = createCourseGenerationStarter({
      registry,
      resolveModels,
      store: { createRun },
    });

    await starter.start({
      aiProvider: 'codex',
      assessmentHistory: [{ role: 'user', text: 'Voglio capire i sistemi distribuiti.' }],
      mode: 'learn',
      projectId: 'project-1',
      requestKey: 'request-1',
      userId: 'user-1',
    });

    expect(resolveModels).toHaveBeenCalledWith('codex', undefined);
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ models }),
        dedupeKey: '["course-generation","project-1"]',
        input: {
          assessmentHistory: [{ role: 'user', text: 'Voglio capire i sistemi distribuiti.' }],
          mode: 'learn',
          projectId: 'project-1',
          userId: 'user-1',
        },
        projectId: 'project-1',
        requestKey: 'request-1',
        userId: 'user-1',
        workflowId: 'course-generation',
      })
    );
  });
});
