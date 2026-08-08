import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { createCourseInterviewStarter } from '../../src/workflows/courseInterviewStart.js';
import { createCourseInterviewWorkflow } from '../../src/workflows/courseInterviewWorkflow.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';

describe('course interview start', () => {
  test('persists resolved models and deterministic source context', async () => {
    const models = getGlobalModelConfig();
    const registry = createWorkflowRegistry();
    registry.register({
      current: createCourseInterviewWorkflow({ maxAttempts: 3, models, timeoutMs: 60_000 }, 8),
    });
    const createRun = vi.fn().mockResolvedValue({
      created: true,
      run: { id: 'run-1', status: 'queued' },
    });
    const starter = createCourseInterviewStarter({
      registry,
      resolveModels: vi.fn().mockResolvedValue(models),
      store: { createRun },
    });

    await starter.start({
      hasReliableSourceContext: true,
      initialMessage: 'Voglio un corso pratico.',
      mode: 'learn',
      projectId: 'project-1',
      requestKey: 'request-1',
      sourceContext: 'Contesto della fonte.',
      userId: 'user-1',
    });

    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ models }),
        input: {
          hasReliableSourceContext: true,
          initialMessage: 'Voglio un corso pratico.',
          mode: 'learn',
          projectId: 'project-1',
          sourceContext: 'Contesto della fonte.',
          userId: 'user-1',
        },
        projectId: 'project-1',
        requestKey: 'request-1',
        userId: 'user-1',
        workflowId: 'course-interview',
      })
    );
  });
});
