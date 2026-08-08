import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { resolveLessonVisualModelConfig } from '../../src/services/lessonVisualModelConfig.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import {
  createLessonGenerationStarter,
  lessonGenerationDedupeKey,
  mapPreviousSublessonIdempotencyInput,
} from '../../src/workflows/lessonGenerationStart.js';
import { createLessonGenerationWorkflow } from '../../src/workflows/lessonGenerationWorkflow.js';

const models = getGlobalModelConfig();
const config = {
  maxAttempts: 3,
  models,
  timeoutMs: 600_000,
  visual: resolveLessonVisualModelConfig(models),
};

describe('lesson generation workflow start', () => {
  test('freezes resolved models and shares one active-work identity per project', async () => {
    const registry = createWorkflowRegistry();
    registry.register({ current: createLessonGenerationWorkflow(config) });
    const createRun = vi.fn().mockResolvedValue({
      created: true,
      run: { id: 'run-1', status: 'queued' },
    });
    const resolveModels = vi.fn().mockResolvedValue(models);
    const starter = createLessonGenerationStarter({
      registry,
      resolveModels,
      store: { createRun },
    });
    const idempotencyInput = {
      focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
      kind: 'sublesson',
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      userId: 'user-1',
    };

    await starter.start({
      aiProvider: 'codex',
      focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
      forceRegenerate: false,
      idempotencyInput,
      kind: 'sublesson',
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      requestKey: 'request-1',
      sectionId: 'sublesson-1',
      userId: 'user-1',
    });

    expect(resolveModels).toHaveBeenCalledWith('codex', undefined);
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          models,
          visual: resolveLessonVisualModelConfig(models),
        }),
        dedupeKey: lessonGenerationDedupeKey('project-1'),
        idempotencyInput,
        input: {
          focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
          forceRegenerate: false,
          kind: 'sublesson',
          parentSectionId: 'lesson-1',
          projectId: 'project-1',
          sectionId: 'sublesson-1',
          userId: 'user-1',
        },
        mapPreviousIdempotencyInput: mapPreviousSublessonIdempotencyInput,
        projectId: 'project-1',
        requestKey: 'request-1',
        userId: 'user-1',
        workflowId: 'lesson-generation',
      })
    );
  });

  test('maps only the previous persisted sublesson shape to stable request semantics', () => {
    expect(
      mapPreviousSublessonIdempotencyInput({
        focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
        forceRegenerate: false,
        kind: 'sublesson',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        sectionId: 'old-server-id',
        userId: 'user-1',
      })
    ).toEqual({
      focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
      kind: 'sublesson',
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      userId: 'user-1',
    });
    expect(
      mapPreviousSublessonIdempotencyInput({
        forceRegenerate: false,
        kind: 'existing',
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      })
    ).toBeUndefined();
    expect(mapPreviousSublessonIdempotencyInput({ kind: 'sublesson' })).toBeUndefined();
    expect(
      mapPreviousSublessonIdempotencyInput({
        extra: 'unexpected',
        focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
        forceRegenerate: false,
        kind: 'sublesson',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        sectionId: 'old-server-id',
        userId: 'user-1',
      })
    ).toBeUndefined();
    expect(
      mapPreviousSublessonIdempotencyInput({
        focus: {
          extra: 'unexpected',
          instructions: 'Approfondisci',
          selectedText: 'orologio globale',
        },
        forceRegenerate: false,
        kind: 'sublesson',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        sectionId: 'old-server-id',
        userId: 'user-1',
      })
    ).toBeUndefined();
  });
});
