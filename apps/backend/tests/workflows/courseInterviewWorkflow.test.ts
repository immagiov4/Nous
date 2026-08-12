import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  type CourseInterviewWorkflowConfig,
  type CourseInterviewWorkflowServices,
  createCourseInterviewWorkflow,
} from '../../src/workflows/courseInterviewWorkflow.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import type {
  EmitDefinition,
  RouteByDefinition,
  StepDefinition,
  WaitForSignalDefinition,
  WorkflowNode,
} from '../../src/workflows/types.js';
import { indexWorkflowNodes } from '../../src/workflows/workflowNodeIndex.js';

const config: CourseInterviewWorkflowConfig = {
  maxAttempts: 3,
  models: getGlobalModelConfig(),
  timeoutMs: 60_000,
};

const profile = {
  context: 'Studente di informatica con basi di reti.',
  experienceLevel: 'Intermediate',
  goals: 'Capire e progettare sistemi distribuiti.',
  language: 'Italiano',
  learningStyle: 'Practical',
  topic: 'Sistemi distribuiti',
};

const state = {
  decision: 'active' as const,
  hasReliableSourceContext: false,
  messages: [{ role: 'user' as const, text: 'Voglio un corso.' }],
  mode: 'learn' as const,
  projectId: 'project-1',
  userId: 'user-1',
};

const findNode = (id: string): WorkflowNode => {
  const definition = createCourseInterviewWorkflow(config, 8);
  const node = [...indexWorkflowNodes(definition).values()].find(
    entry => entry.node.id === id
  )?.node;
  if (!node) throw new Error(`Missing test workflow node ${id}.`);
  return node;
};

const makeServices = (
  overrides: Partial<CourseInterviewWorkflowServices> = {}
): CourseInterviewWorkflowServices => ({
  assessTurn: vi.fn(async () => ({ kind: 'question', message: 'Qual è il tuo obiettivo?' })),
  discardUnclaimedDraftProject: vi.fn(async () => undefined),
  saveCourseProfile: vi.fn(async () => undefined),
  saveCourseProfileBeforeCheckpoint: vi.fn(async () => undefined),
  startCourseGeneration: vi.fn(async () => ({ runId: 'generation-1' })),
  ...overrides,
});

const stepContext = (input: unknown, services: CourseInterviewWorkflowServices) => ({
  attemptNumber: 1,
  config,
  execution: { nodeInstanceId: 'node-1', runId: 'interview-1' },
  idempotencyKey: 'node-key',
  input,
  retryFeedback: '',
  services,
  signal: new AbortController().signal,
});

describe('course interview workflow', () => {
  test('registers durable messages, proposal, generation and typed signals', () => {
    const definition = createCourseInterviewWorkflow(config, 8);
    const registered = createWorkflowRegistry().register({ current: definition }).current;

    expect(registered.id).toBe('course-interview');
    expect(Object.keys(registered.events).sort()).toEqual([
      'course-generation-started',
      'course-interview-ended',
      'course-interview-message',
      'course-proposal-ready',
    ]);
    expect(Object.keys(registered.signals).sort()).toEqual(['course-decision', 'user-answer']);
    expect([...indexWorkflowNodes(definition).values()].map(entry => entry.node.id)).toEqual(
      expect.arrayContaining([
        'wait-for-course-interview-answer',
        'wait-for-course-interview-decision',
        'discard-exhausted-course-interview-draft',
      ])
    );
  });

  test('resumes an answer by preserving the question and user response', () => {
    const wait = findNode('wait-for-course-interview-answer') as WaitForSignalDefinition<
      unknown,
      { text: string },
      unknown
    >;
    const resumed = wait.resume(
      { state, turn: { kind: 'question', message: 'Qual è il tuo obiettivo?' } },
      { text: 'Prepararmi a un esame.' }
    );

    expect(resumed).toEqual({
      ...state,
      messages: [
        ...state.messages,
        { role: 'model', text: 'Qual è il tuo obiettivo?' },
        { role: 'user', text: 'Prepararmi a un esame.' },
      ],
    });
  });

  test('routes proposal decisions without semantic text matching', () => {
    const wait = findNode('wait-for-course-interview-decision') as WaitForSignalDefinition<
      unknown,
      { details?: string; kind: 'add-details' | 'approve' | 'cancel' },
      unknown
    >;
    const turn = {
      state,
      turn: { kind: 'proposal' as const, message: 'Il percorso è pronto.', proposal: profile },
    };

    expect(wait.resume(turn, { kind: 'approve' })).toEqual(
      expect.objectContaining({ decision: 'approve', profile })
    );
    expect(wait.resume(turn, { details: 'Più esercizi pratici.', kind: 'add-details' })).toEqual(
      expect.objectContaining({
        decision: 'active',
        messages: expect.arrayContaining([{ role: 'user', text: 'Più esercizi pratici.' }]),
        profile,
      })
    );
    expect(wait.resume(turn, { kind: 'cancel' })).toEqual(
      expect.objectContaining({ decision: 'cancel', profile })
    );
  });

  test('checkpoints the complete profile before starting one distinct generation', async () => {
    const saveCourseProfile = vi.fn(async () => undefined);
    const startCourseGeneration = vi.fn(async () => ({ runId: 'generation-1' }));
    const services = makeServices({ saveCourseProfile, startCourseGeneration });
    const approved = { ...state, decision: 'approve' as const, profile };
    const save = findNode('save-course-interview-profile') as StepDefinition<unknown, unknown>;
    const start = findNode('start-course-generation-from-interview') as StepDefinition<
      unknown,
      unknown
    >;

    const saved = await save.run(stepContext(approved, services));
    expect(saveCourseProfile).not.toHaveBeenCalled();
    await save.commit?.({
      config,
      execution: { nodeInstanceId: 'node-1', runId: 'interview-1' },
      input: approved,
      output: saved,
      services,
      transaction: {} as never,
    });
    const started = await start.run(stepContext(saved, services));

    expect(saveCourseProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profile, projectId: 'project-1', userId: 'user-1' })
    );
    expect(startCourseGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        assessmentHistory: approved.messages,
        idempotencyKey: 'node-key',
        projectId: 'project-1',
      })
    );
    expect(started).toEqual({ ...approved, generationRunId: 'generation-1' });
  });

  test('keeps the pre-checkpoint profile effect only in the resumable legacy definition', async () => {
    const saveCourseProfileBeforeCheckpoint = vi.fn(async () => undefined);
    const services = makeServices({ saveCourseProfileBeforeCheckpoint });
    const definition = createCourseInterviewWorkflow(config, 8, undefined, 'run');
    const save = [...indexWorkflowNodes(definition).values()].find(
      entry => entry.node.id === 'save-course-interview-profile'
    )?.node as StepDefinition<unknown, unknown> | undefined;
    if (!save) throw new Error('Missing legacy profile persistence step.');

    expect(definition.compatibilityId).toBe('course-interview-v1');
    expect(save.commit).toBeUndefined();
    await save.run(stepContext({ ...state, decision: 'approve' as const, profile }, services));

    expect(saveCourseProfileBeforeCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'node-key',
        profile,
        projectId: 'project-1',
        userId: 'user-1',
      })
    );
  });

  test('keeps cleanup authoritative for cancellation, expiry and the iteration fuse', async () => {
    const discardUnclaimedDraftProject = vi.fn(async () => undefined);
    const services = makeServices({ discardUnclaimedDraftProject });
    const own = findNode('own-course-interview-draft-lifetime') as StepDefinition<unknown, unknown>;
    const exhausted = findNode('discard-exhausted-course-interview-draft') as StepDefinition<
      unknown,
      unknown
    >;
    const input = {
      hasReliableSourceContext: false,
      mode: 'learn',
      projectId: 'project-1',
      userId: 'user-1',
    };

    await own.undo?.({
      config,
      execution: { nodeInstanceId: 'own', runId: 'interview-1' },
      idempotencyKey: 'undo-key',
      input,
      output: input,
      services,
      signal: new AbortController().signal,
    });
    await exhausted.run(stepContext({ ...state, decision: 'exhausted' }, services));

    expect(discardUnclaimedDraftProject).toHaveBeenCalledTimes(2);
  });

  test('publishes the full proposal and generation identity', () => {
    const proposalEvent = findNode('emit-course-interview-proposal') as EmitDefinition<unknown>;
    const generationEvent = findNode('emit-course-generation-started') as EmitDefinition<unknown>;

    expect(
      proposalEvent.payload({
        state,
        turn: { kind: 'proposal', message: 'Pronto.', proposal: profile },
      })
    ).toEqual({ proposal: profile });
    expect(generationEvent.payload({ ...state, generationRunId: 'generation-1' })).toEqual({
      generationRunId: 'generation-1',
      projectId: 'project-1',
    });
  });

  test('publishes the terminal result after cleanup', () => {
    const ended = findNode('emit-course-interview-ended') as EmitDefinition<unknown>;

    expect(ended.payload({ kind: 'cancelled', projectId: 'project-1' })).toEqual({
      kind: 'cancelled',
      projectId: 'project-1',
    });
  });

  test('routes semantic model cancellation to the typed cancellation branch', () => {
    const route = findNode('route-course-interview-turn') as RouteByDefinition<unknown, unknown>;
    expect(route.select({ state, turn: { kind: 'cancelled', message: 'Va bene, annullo.' } })).toBe(
      'cancelled'
    );
  });
});
