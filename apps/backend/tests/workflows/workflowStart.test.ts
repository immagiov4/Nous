import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { createWorkflowRegistry, emit, step, workflow } from '../../src/workflows/definition.js';
import type { CreateWorkflowRunInput } from '../../src/workflows/postgresWorkflowStore.js';
import { startWorkflowRun, type WorkflowRunCreator } from '../../src/workflows/workflowStart.js';

const Config = z.object({
  maxAttempts: z.number().int().positive(),
  model: z.object({ name: z.string(), reasoning: z.string() }),
  timeoutMs: z.number().int().positive(),
});
const Payload = z.object({ content: z.string() });

const registry = createWorkflowRegistry();
const definition = registry.register({
  current: workflow({
    configSchema: Config,
    executionDefaults: {
      maxAttempts: 3,
      model: { name: 'default-model', reasoning: 'low' },
      timeoutMs: 60_000,
    },
    id: 'start-test',
    inputSchema: Payload,
    outputSchema: Payload,
    root: step({
      id: 'generate',
      inputSchema: Payload,
      outputSchema: Payload,
      run: async ({ input }) => input,
    }),
  }),
}).current;

describe('startWorkflowRun', () => {
  test('validates and freezes the current definition input and resolved configuration', async () => {
    let persisted: CreateWorkflowRunInput | undefined;
    const createRun = vi.fn(async (input: CreateWorkflowRunInput) => {
      persisted = input;
      return {
        created: true,
        run: {
          cancellationRequested: false,
          cleanupStatus: 'not-required' as const,
          createdAt: '2026-07-29T10:00:00.000Z',
          definitionHash: input.definitionHash,
          definitionHashVersion: input.definitionHashVersion,
          id: input.id,
          input: input.input,
          requestKey: input.requestKey,
          resolvedConfig: input.config,
          status: 'queued' as const,
          stepPolicies: input.materialization.stepPolicies,
          stepPoliciesVersion: input.materialization.stepPoliciesVersion,
          updatedAt: '2026-07-29T10:00:00.000Z',
          userId: input.userId,
          workflowId: input.workflowId,
        },
      };
    });

    const result = await startWorkflowRun({
      configOverride: { model: { name: 'lesson-model' } },
      createId: () => '11111111-1111-4111-8111-111111111111',
      dedupeKey: 'lesson:project-1:section-1',
      input: { content: 'draft', ignored: true },
      projectId: 'project-1',
      registry,
      requestKey: 'request-1',
      store: { createRun },
      userId: '22222222-2222-4222-8222-222222222222',
      workflowId: definition.id,
    });

    expect(result.created).toBe(true);
    expect(persisted).toMatchObject({
      config: {
        maxAttempts: 3,
        model: { name: 'lesson-model', reasoning: 'low' },
        timeoutMs: 60_000,
      },
      definitionHash: definition.definitionHash,
      id: '11111111-1111-4111-8111-111111111111',
      input: { content: 'draft' },
      workflowId: definition.id,
    });
    expect(Object.isFrozen(persisted?.config)).toBe(true);
    expect(Object.isFrozen((persisted?.config as { model: unknown }).model)).toBe(true);
    expect(Object.isFrozen(persisted?.input)).toBe(true);
  });

  test('rejects invalid input before touching persistence', async () => {
    const createRun = vi.fn<WorkflowRunCreator['createRun']>();

    await expect(
      startWorkflowRun({
        input: { content: 42 },
        registry,
        requestKey: 'request-2',
        store: { createRun },
        userId: '22222222-2222-4222-8222-222222222222',
        workflowId: definition.id,
      })
    ).rejects.toThrow();
    expect(createRun).not.toHaveBeenCalled();
  });

  test('does not fall back when the requested current workflow is absent', async () => {
    const createRun = vi.fn<WorkflowRunCreator['createRun']>();

    await expect(
      startWorkflowRun({
        input: { content: 'draft' },
        registry,
        requestKey: 'request-3',
        store: { createRun },
        userId: '22222222-2222-4222-8222-222222222222',
        workflowId: 'missing',
      })
    ).rejects.toThrow('Workflow is not registered: missing');
    expect(createRun).not.toHaveBeenCalled();
  });

  test('publishes initial transient events only for a newly created run', async () => {
    const transientRegistry = createWorkflowRegistry();
    const transientDefinition = transientRegistry.register({
      current: workflow({
        configSchema: Config,
        events: {
          progress: {
            durability: 'transient',
            schema: Payload,
            schemaVersion: 1,
          },
        },
        executionDefaults: {
          maxAttempts: 3,
          model: { name: 'default-model', reasoning: 'low' },
          timeoutMs: 60_000,
        },
        id: 'transient-start-test',
        inputSchema: Payload,
        outputSchema: Payload,
        root: emit({
          event: 'progress',
          id: 'announce',
          inputSchema: Payload,
          payload: input => input,
        }),
      }),
    }).current;
    const publishTransientEvent = vi.fn();
    const createRun = vi.fn(async (input: CreateWorkflowRunInput) => ({
      created: true,
      run: {
        cancellationRequested: false,
        cleanupStatus: 'not-required' as const,
        completedAt: '2026-07-29T10:00:00.000Z',
        createdAt: '2026-07-29T10:00:00.000Z',
        definitionHash: input.definitionHash,
        definitionHashVersion: input.definitionHashVersion,
        id: input.id,
        input: input.input,
        output: input.input,
        requestKey: input.requestKey,
        resolvedConfig: input.config,
        status: 'completed' as const,
        stepPolicies: input.materialization.stepPolicies,
        stepPoliciesVersion: input.materialization.stepPoliciesVersion,
        updatedAt: '2026-07-29T10:00:00.000Z',
        userId: input.userId,
        workflowId: input.workflowId,
      },
    }));

    const first = await startWorkflowRun({
      createId: () => '33333333-3333-4333-8333-333333333333',
      input: { content: 'starting' },
      publishTransientEvent,
      registry: transientRegistry,
      requestKey: 'request-transient',
      store: { createRun },
      userId: '22222222-2222-4222-8222-222222222222',
      workflowId: transientDefinition.id,
    });

    expect(publishTransientEvent).toHaveBeenCalledWith({
      eventType: 'progress',
      payload: { content: 'starting' },
      runId: '33333333-3333-4333-8333-333333333333',
      schemaVersion: 1,
      workflowId: transientDefinition.id,
    });

    vi.mocked(createRun).mockResolvedValueOnce({ created: false, run: first.run });
    publishTransientEvent.mockClear();
    await startWorkflowRun({
      createId: () => '44444444-4444-4444-8444-444444444444',
      input: { content: 'starting' },
      publishTransientEvent,
      registry: transientRegistry,
      requestKey: 'request-replayed',
      store: { createRun },
      userId: '22222222-2222-4222-8222-222222222222',
      workflowId: transientDefinition.id,
    });
    expect(publishTransientEvent).not.toHaveBeenCalled();
  });
});
