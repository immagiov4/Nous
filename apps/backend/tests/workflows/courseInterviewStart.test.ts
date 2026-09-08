import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { createCourseInterviewStarter } from '../../src/workflows/courseInterviewStart.js';
import { createCourseInterviewWorkflow } from '../../src/workflows/courseInterviewWorkflow.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';

describe('course interview start', () => {
  test('captures account defaults once in the new run without modifying the account', async () => {
    const models = getGlobalModelConfig();
    const registry = createWorkflowRegistry();
    registry.register({
      current: createCourseInterviewWorkflow({ maxAttempts: 3, models, timeoutMs: 60_000 }, 8),
    });
    const savedPreferences = {
      interfaceLocale: 'it' as const,
      contentLanguage: '日本語',
      teachingPreferences: 'One step at a time.',
    };
    const readPreferences = vi.fn().mockResolvedValue(savedPreferences);
    const createRun = vi
      .fn()
      .mockResolvedValue({ created: true, run: { id: 'run-1', status: 'queued' } });
    const starter = createCourseInterviewStarter({
      registry,
      readPreferences,
      resolveModels: vi.fn().mockResolvedValue(models),
      store: { createRun },
    });
    await starter.start({
      hasReliableSourceContext: false,
      initialMessage: 'Learn trees.',
      interfaceLocale: 'en',
      mode: 'learn',
      projectId: 'project-1',
      requestKey: 'request-1',
      userId: 'user-1',
    });
    expect(readPreferences).toHaveBeenCalledExactlyOnceWith('user-1');
    const defaults = createRun.mock.calls[0]?.[0].input.preferenceDefaults;
    expect(defaults).toEqual({ language: '日本語', teachingPreferences: 'One step at a time.' });
    savedPreferences.contentLanguage = 'English';
    savedPreferences.teachingPreferences = '';
    expect(defaults).toEqual({ language: '日本語', teachingPreferences: 'One step at a time.' });
  });
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
