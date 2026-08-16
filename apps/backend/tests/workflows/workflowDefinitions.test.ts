import { describe, expect, test } from 'vitest';
import * as z from 'zod';
import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import {
  continueRepeatWith,
  createWorkflowRegistry,
  emit,
  fanOut,
  finishRepeat,
  preCompatibilityIdAndExternalEffectPrevious,
  preCompatibilityIdPrevious,
  preExternalEffectPrevious,
  preProviderPostprocessingPrevious,
  repeat,
  repeatDecisionSchema,
  routeBy,
  sequence,
  step,
  waitForSignal,
  workflow,
} from '../../src/workflows/definition.js';
import {
  canonicalJson,
  durableSchemaShape,
  schemasMatch,
} from '../../src/workflows/schemaFingerprint.js';
import type { SequenceDefinition, WorkflowNode } from '../../src/workflows/types.js';

const LessonInput = z.object({ projectId: z.string(), sectionId: z.string() });
const LessonDraft = z.object({ content: z.string(), projectId: z.string(), sectionId: z.string() });
const ApprovalSignal = z.object({ approved: z.literal(true) });
const TEST_EXECUTION_DEFAULTS = { maxAttempts: 3, timeoutMs: 60_000 };
const TEST_CONFIG_SCHEMA = WorkflowExecutionDefaultsSchema;

const makeLessonWorkflow = (options: {
  compatibilityId?: string;
  externalEffect?: 'provider' | 'provider-with-postprocessing';
  promptVariant?: string;
  waitForApproval?: boolean;
}) => {
  const prepare = step({
    ...(options.externalEffect ? { externalEffect: options.externalEffect } : {}),
    id: 'prepare',
    inputSchema: LessonInput,
    outputSchema: LessonDraft,
    run: async ({ input }) => ({ ...input, content: options.promptVariant ?? 'draft' }),
  });
  const nodes = [
    prepare,
    ...(options.waitForApproval
      ? [
          emit({
            id: 'draft-ready',
            event: 'draftReady',
            inputSchema: LessonDraft,
            payload: input => ({ sectionId: input.sectionId }),
          }),
          waitForSignal({
            id: 'approval',
            inputSchema: LessonDraft,
            outputSchema: LessonDraft,
            payloadSchema: ApprovalSignal,
            signal: 'approveDraft',
            resume: input => input,
          }),
        ]
      : []),
  ] as const;

  return workflow({
    compatibilityId: options.compatibilityId ?? 'lesson-generation-v1',
    configSchema: TEST_CONFIG_SCHEMA,
    id: 'lesson-generation',
    inputSchema: LessonInput,
    outputSchema: LessonDraft,
    events: {
      draftReady: {
        durability: 'durable',
        schema: z.object({ sectionId: z.string() }),
        schemaVersion: 1,
      },
    },
    executionDefaults: TEST_EXECUTION_DEFAULTS,
    signals: {
      approveDraft: { schema: ApprovalSignal, schemaVersion: 1 },
    },
    root: sequence({ id: 'lesson', nodes }),
  });
};

describe('workflow definition registration', () => {
  test('composes workflows as scoped nodes without colliding on internal ids', () => {
    const makeNested = (id: string) =>
      workflow({
        compatibilityId: `${id}-v1`,
        configSchema: TEST_CONFIG_SCHEMA,
        executionDefaults: TEST_EXECUTION_DEFAULTS,
        id,
        inputSchema: LessonInput,
        outputSchema: LessonInput,
        root: step({
          id: 'transform',
          inputSchema: LessonInput,
          outputSchema: LessonInput,
          run: async ({ input }) => input,
        }),
      });
    const definition = workflow({
      compatibilityId: 'nested-composition-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      id: 'nested-composition',
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      root: sequence({ id: 'root', nodes: [makeNested('left'), makeNested('right')] }),
    });

    const registered = createWorkflowRegistry().register({ current: definition }).current;

    expect(registered.manifest.root).toMatchObject({
      kind: 'sequence',
      nodes: [
        { id: 'left', kind: 'workflow', root: { id: 'transform', kind: 'step' } },
        { id: 'right', kind: 'workflow', root: { id: 'transform', kind: 'step' } },
      ],
    });
  });

  test('registers one current definition and resolves it by its structural hash', () => {
    const registry = createWorkflowRegistry();
    const definition = makeLessonWorkflow({ waitForApproval: true });

    const registered = registry.register({ current: definition });

    expect(registered.current.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(registered.current.definitionHashVersion).toBe(1);
    expect(registered.current.manifest.definitionHashVersion).toBe(1);
    expect(registry.current('lesson-generation')).toBe(registered.current);
    expect(registry.resolve('lesson-generation', registered.current.definitionHash)).toBe(
      registered.current
    );
  });

  test('keeps the version-one definition hash stable for its golden manifest', () => {
    const registered = createWorkflowRegistry().register({
      current: makeLessonWorkflow({ waitForApproval: true }),
    }).current;

    expect(registered.definitionHash).toBe(
      '94257254b029c8b914bc05ae8df9e45617846b30fa92bdf7305620f56688bf1e'
    );
  });

  test('keeps callback and prompt-only changes compatible', () => {
    const first = createWorkflowRegistry().register({
      current: makeLessonWorkflow({ promptVariant: 'first', waitForApproval: false }),
    }).current;
    const second = createWorkflowRegistry().register({
      current: makeLessonWorkflow({ promptVariant: 'second', waitForApproval: false }),
    }).current;

    expect(first.definitionHash).toBe(second.definitionHash);
  });

  test('changes the hash when a step gains provider result persistence', () => {
    const plain = createWorkflowRegistry().register({
      current: makeLessonWorkflow({ waitForApproval: false }),
    }).current;
    const provider = createWorkflowRegistry().register({
      current: makeLessonWorkflow({ externalEffect: 'provider', waitForApproval: false }),
    }).current;

    expect(provider.definitionHash).not.toBe(plain.definitionHash);
  });

  test('reconstructs the previous hash before provider effects entered manifests', () => {
    const plain = createWorkflowRegistry().register({
      current: makeLessonWorkflow({ waitForApproval: false }),
    }).current;
    const providerDefinition = makeLessonWorkflow({
      externalEffect: 'provider',
      waitForApproval: false,
    });
    const registered = createWorkflowRegistry().register({
      current: providerDefinition,
      previous: preExternalEffectPrevious(providerDefinition),
    });

    expect(registered.current.definitionHash).not.toBe(plain.definitionHash);
    expect(registered.previous?.definitionHash).toBe(plain.definitionHash);
  });

  test('reconstructs the previous hash before provider post-processing had its own boundary', () => {
    const provider = createWorkflowRegistry().register({
      current: makeLessonWorkflow({ externalEffect: 'provider', waitForApproval: false }),
    }).current;
    const postprocessedDefinition = makeLessonWorkflow({
      externalEffect: 'provider-with-postprocessing',
      waitForApproval: false,
    });
    const registered = createWorkflowRegistry().register({
      current: postprocessedDefinition,
      previous: preProviderPostprocessingPrevious(postprocessedDefinition),
    });

    expect(registered.current.definitionHash).not.toBe(provider.definitionHash);
    expect(registered.previous?.definitionHash).toBe(provider.definitionHash);
  });

  test('reconstructs hashes predating compatibility ids and provider effects', () => {
    const plainDefinition = makeLessonWorkflow({ waitForApproval: false });
    const historical = createWorkflowRegistry().register({
      current: plainDefinition,
      previous: preCompatibilityIdPrevious(plainDefinition),
    }).previous;
    const providerDefinition = makeLessonWorkflow({
      externalEffect: 'provider',
      waitForApproval: false,
    });
    const registered = createWorkflowRegistry().register({
      current: providerDefinition,
      previous: preCompatibilityIdAndExternalEffectPrevious(providerDefinition),
    });

    expect(registered.previous?.definitionHash).toBe(historical?.definitionHash);
  });

  test('keeps unrelated externalEffect schema fields in the previous hash', () => {
    const State = z.object({ externalEffect: z.string() });
    const definitionFor = (providerEffect: boolean) =>
      workflow({
        compatibilityId: 'schema-field-v1',
        configSchema: TEST_CONFIG_SCHEMA,
        executionDefaults: TEST_EXECUTION_DEFAULTS,
        id: 'schema-field',
        inputSchema: State,
        outputSchema: State,
        root: step({
          ...(providerEffect ? { externalEffect: 'provider' as const } : {}),
          id: 'identity',
          inputSchema: State,
          outputSchema: State,
          run: async ({ input }) => input,
        }),
      });
    const plain = createWorkflowRegistry().register({ current: definitionFor(false) }).current;
    const registered = createWorkflowRegistry().register({
      current: definitionFor(true),
      previous: preExternalEffectPrevious(definitionFor(true)),
    });

    expect(registered.previous?.definitionHash).toBe(plain.definitionHash);
  });

  test('changes the hash for structural and explicit compatibility changes', () => {
    const base = createWorkflowRegistry().register({
      current: makeLessonWorkflow({ waitForApproval: false }),
    }).current;
    const structural = createWorkflowRegistry().register({
      current: makeLessonWorkflow({ waitForApproval: true }),
    }).current;
    const incompatible = createWorkflowRegistry().register({
      current: makeLessonWorkflow({
        compatibilityId: 'new-lesson-contract',
        waitForApproval: false,
      }),
    }).current;

    expect(structural.definitionHash).not.toBe(base.definitionHash);
    expect(incompatible.definitionHash).not.toBe(base.definitionHash);
  });

  test('allows resumable definitions only for their persisted hash', () => {
    const previous = makeLessonWorkflow({ compatibilityId: 'previous', waitForApproval: false });
    const current = makeLessonWorkflow({ compatibilityId: 'current', waitForApproval: true });
    const registry = createWorkflowRegistry();
    const registered = registry.register({ current, previous });
    const previousDefinition = registered.previous;
    if (!previousDefinition) throw new Error('Expected one resumable workflow definition.');

    expect(registry.current('lesson-generation')).toBe(registered.current);
    expect(registry.resolve('lesson-generation', previousDefinition.definitionHash)).toBe(
      previousDefinition
    );
    expect(registry.listRegisteredBoundaries()).toEqual([
      {
        definitionHash: registered.current.definitionHash,
        definitionHashVersion: registered.current.definitionHashVersion,
        workflowId: registered.current.id,
      },
      {
        definitionHash: previousDefinition.definitionHash,
        definitionHashVersion: previousDefinition.definitionHashVersion,
        workflowId: previousDefinition.id,
      },
    ]);
    expect(registry.resolve('lesson-generation', 'missing')).toBeNull();
  });

  test('resolves a run persisted before compatibility ids entered the manifest', () => {
    const definition = makeLessonWorkflow({ waitForApproval: false });
    const registry = createWorkflowRegistry();
    const registration = registry.register({
      current: makeLessonWorkflow({
        compatibilityId: 'lesson-generation-v2',
        waitForApproval: true,
      }),
      previous: preCompatibilityIdPrevious(definition),
    });
    const previous = registration.previous;
    if (!previous) throw new Error('Expected the pre-migration workflow definition.');

    const persistedPreMigrationHash =
      '3a84101cb97721700b92630e74ec669833a662f3fb41ee06932a4090121d1ab4';
    expect(previous.definitionHash).toBe(persistedPreMigrationHash);
    expect(registration.current.definitionHash).not.toBe(persistedPreMigrationHash);
    expect(registration.current.manifest.compatibilityId).toBe('lesson-generation-v2');
    expect(registry.resolve('lesson-generation', persistedPreMigrationHash)?.compatibilityId).toBe(
      'lesson-generation-v1'
    );
  });

  test('retains multiple historical definitions for runs crossing consecutive deploys', () => {
    const previous = makeLessonWorkflow({
      compatibilityId: 'lesson-generation-v1',
      waitForApproval: false,
    });
    const registry = createWorkflowRegistry();
    const registration = registry.register({
      current: makeLessonWorkflow({
        compatibilityId: 'lesson-generation-v2',
        waitForApproval: true,
      }),
      previous: [previous, preCompatibilityIdPrevious(previous)],
    });
    const [durablePrevious, preCompatibilityPrevious] = registration.previousDefinitions;
    if (!durablePrevious || !preCompatibilityPrevious) {
      throw new Error('Expected both historical workflow definitions.');
    }

    expect(registration.previous).toBe(durablePrevious);
    expect(registry.resolve('lesson-generation', durablePrevious.definitionHash)).toBe(
      durablePrevious
    );
    expect(registry.resolve('lesson-generation', preCompatibilityPrevious.definitionHash)).toBe(
      preCompatibilityPrevious
    );
    expect(registry.listDefinitionDeployments()[0]?.supportedDefinitions).toHaveLength(3);
  });

  test('accepts type-erased resumable definitions with historical schemas', () => {
    const current = workflow({
      compatibilityId: 'current-contract',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      id: 'evolving-workflow',
      inputSchema: z.object({ current: z.string() }),
      outputSchema: z.object({ current: z.string() }),
      root: step({
        id: 'current-step',
        inputSchema: z.object({ current: z.string() }),
        outputSchema: z.object({ current: z.string() }),
        run: async ({ input }) => input,
      }),
    });
    const previous = workflow({
      compatibilityId: 'previous-contract',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      id: 'evolving-workflow',
      inputSchema: z.object({ previous: z.number() }),
      outputSchema: z.object({ previous: z.number() }),
      root: step({
        id: 'previous-step',
        inputSchema: z.object({ previous: z.number() }),
        outputSchema: z.object({ previous: z.number() }),
        run: async ({ input }) => input,
      }),
    });

    const registration = createWorkflowRegistry().register({
      current,
      previous,
    });

    expect(registration.previous).not.toBeNull();
  });

  test('registers route, fan-out and repeat as structural primitives', () => {
    const DraftState = z.object({ content: z.string(), revision: z.number() });
    const review = step({
      id: 'review',
      inputSchema: DraftState,
      outputSchema: repeatDecisionSchema(DraftState),
      run: async ({ input }) =>
        input.revision > 0
          ? finishRepeat(input)
          : continueRepeatWith({ ...input, revision: input.revision + 1 }),
    });
    const refine = repeat({
      id: 'refine',
      body: review,
      maxIterations: 2,
      onExhausted: state => state,
      stateSchema: DraftState,
    });
    const worker = step({
      id: 'render-one',
      inputSchema: z.string(),
      outputSchema: z.string(),
      run: async ({ input }) => input.toUpperCase(),
    });
    const render = fanOut({
      failureMode: 'collect',
      fanIn: results => ({
        outputs: results.flatMap(result => (result.status === 'completed' ? [result.output] : [])),
      }),
      id: 'render',
      inputSchema: DraftState,
      inputs: input => input.content.split(' '),
      itemSchema: z.string(),
      keyBy: input => input,
      outputSchema: z.object({ outputs: z.array(z.string()) }),
      worker,
    });
    const branch = routeBy({
      cases: {
        plain: render,
      },
      id: 'format',
      inputSchema: DraftState,
      outputSchema: render.outputSchema,
      select: () => 'plain',
    });
    const definition = workflow({
      compatibilityId: 'composed-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      id: 'composed',
      inputSchema: DraftState,
      outputSchema: render.outputSchema,
      root: sequence({ id: 'root', nodes: [refine, branch] }),
    });

    expect(
      createWorkflowRegistry().register({ current: definition }).current.manifest.root
    ).toMatchObject({ kind: 'sequence' });
  });
});

describe('workflow definition validation', () => {
  test('rejects a workflow without an explicit compatibility id', () => {
    const { compatibilityId: _compatibilityId, ...definition } = makeLessonWorkflow({
      waitForApproval: false,
    });

    expect(() => createWorkflowRegistry().register({ current: definition as never })).toThrow(
      'compatibilityId is required.'
    );
  });

  test('rejects a nested workflow without an explicit compatibility id', () => {
    const { compatibilityId: _compatibilityId, ...nested } = makeLessonWorkflow({
      waitForApproval: false,
    });
    const definition = workflow({
      compatibilityId: 'parent-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      id: 'parent',
      inputSchema: LessonInput,
      outputSchema: LessonDraft,
      root: nested as never,
    });

    expect(() => createWorkflowRegistry().register({ current: definition })).toThrow(
      'compatibilityId is required at root.lesson-generation.'
    );
  });

  test('rejects nested step overrides that are invalid for the inherited run configuration', () => {
    const Config = WorkflowExecutionDefaultsSchema.extend({
      provider: z.union([
        z.object({ endpoint: z.string(), kind: z.literal('direct') }),
        z.object({ kind: z.literal('regional'), region: z.string() }),
      ]),
    });
    type Config = z.infer<typeof Config>;
    const child = workflow({
      compatibilityId: 'child-v1',
      configSchema: Config,
      executionDefaults: {
        maxAttempts: 3,
        provider: { endpoint: 'child.example', kind: 'direct' },
        timeoutMs: 60_000,
      },
      id: 'child',
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      root: step<typeof LessonInput, typeof LessonInput, Config>({
        config: { provider: { kind: 'direct' } },
        id: 'work',
        inputSchema: LessonInput,
        outputSchema: LessonInput,
        run: async ({ input }) => input,
      }),
    });
    const parent = workflow({
      compatibilityId: 'parent-v1',
      configSchema: Config,
      executionDefaults: {
        maxAttempts: 3,
        provider: { kind: 'regional', region: 'eu' },
        timeoutMs: 60_000,
      },
      id: 'parent',
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      root: child,
    });

    expect(() => createWorkflowRegistry().register({ current: parent })).toThrow(
      'Step work has an invalid configuration override.'
    );
  });

  test('rejects nested step overrides that are invalid against their workflow defaults', () => {
    const Config = WorkflowExecutionDefaultsSchema.extend({
      provider: z.union([
        z.object({ endpoint: z.string(), kind: z.literal('direct') }),
        z.object({ kind: z.literal('regional'), region: z.string() }),
      ]),
    });
    type Config = z.infer<typeof Config>;
    const child = workflow({
      compatibilityId: 'child-v1',
      configSchema: Config,
      executionDefaults: {
        maxAttempts: 3,
        provider: { kind: 'regional', region: 'child-region' },
        timeoutMs: 60_000,
      },
      id: 'child',
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      root: step<typeof LessonInput, typeof LessonInput, Config>({
        config: { provider: { kind: 'direct' } },
        id: 'work',
        inputSchema: LessonInput,
        outputSchema: LessonInput,
        run: async ({ input }) => input,
      }),
    });
    const parent = workflow({
      compatibilityId: 'parent-v1',
      configSchema: Config,
      executionDefaults: {
        maxAttempts: 3,
        provider: { endpoint: 'parent.example', kind: 'direct' },
        timeoutMs: 60_000,
      },
      id: 'parent',
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      root: child,
    });

    expect(() => createWorkflowRegistry().register({ current: parent })).toThrow(
      'Step work has an invalid configuration override.'
    );
  });

  test('rejects a nested workflow with a different run configuration contract', () => {
    const incompatible = workflow({
      compatibilityId: 'incompatible-v1',
      configSchema: WorkflowExecutionDefaultsSchema.extend({ mode: z.string().optional() }),
      executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
      id: 'incompatible',
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      root: step({
        id: 'work',
        inputSchema: LessonInput,
        outputSchema: LessonInput,
        run: async ({ input }) => input,
      }),
    });
    const definition = workflow({
      compatibilityId: 'configuration-boundary-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      id: 'configuration-boundary',
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      root: incompatible as unknown as WorkflowNode,
    });

    expect(() => createWorkflowRegistry().register({ current: definition })).toThrow(
      'Nested workflow incompatible has an incompatible configuration schema.'
    );
  });

  test('rejects step policies that exceed PostgreSQL integer columns', () => {
    const oversizedStep = step({
      id: 'oversized',
      inputSchema: LessonInput,
      maxAttempts: 2_147_483_648,
      outputSchema: LessonInput,
      run: async ({ input }) => input,
    });

    expect(() =>
      createWorkflowRegistry().register({
        current: workflow({
          compatibilityId: 'oversized-step-policy-v1',
          configSchema: TEST_CONFIG_SCHEMA,
          executionDefaults: TEST_EXECUTION_DEFAULTS,
          id: 'oversized-step-policy',
          inputSchema: LessonInput,
          outputSchema: LessonInput,
          root: oversizedStep,
        }),
      })
    ).toThrow('root.oversized.maxAttempts must be a positive PostgreSQL integer.');
  });

  test('rejects a step configuration override that violates the workflow schema', () => {
    const invalidConfigStep = step({
      config: { maxAttempts: 0 },
      id: 'invalid-config',
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      run: async ({ input }) => input,
    });

    expect(() =>
      createWorkflowRegistry().register({
        current: workflow({
          compatibilityId: 'invalid-step-config-v1',
          configSchema: TEST_CONFIG_SCHEMA,
          executionDefaults: TEST_EXECUTION_DEFAULTS,
          id: 'invalid-step-config',
          inputSchema: LessonInput,
          outputSchema: LessonInput,
          root: invalidConfigStep,
        }),
      })
    ).toThrow('Step invalid-config has an invalid configuration override.');
  });

  test('rejects event schema versions that exceed PostgreSQL integer columns', () => {
    expect(() =>
      createWorkflowRegistry().register({
        current: workflow({
          compatibilityId: 'invalid-event-version-v1',
          configSchema: TEST_CONFIG_SCHEMA,
          events: {
            completed: {
              durability: 'durable',
              schema: LessonInput,
              schemaVersion: 2_147_483_648,
            },
          },
          executionDefaults: TEST_EXECUTION_DEFAULTS,
          id: 'oversized-event-version',
          inputSchema: LessonInput,
          outputSchema: LessonInput,
          root: step({
            id: 'identity',
            inputSchema: LessonInput,
            outputSchema: LessonInput,
            run: async ({ input }) => input,
          }),
        }),
      })
    ).toThrow('events.completed.schemaVersion must be a positive PostgreSQL integer.');
  });

  test('fingerprints property names and Zod wrappers without depending on declaration order', () => {
    expect(schemasMatch(z.object({ title: z.string() }), z.object({ title: z.number() }))).toBe(
      false
    );
    expect(
      schemasMatch(
        z.object({ alpha: z.string(), beta: z.number() }),
        z.object({ beta: z.number(), alpha: z.string() })
      )
    ).toBe(true);
    expect(
      schemasMatch(z.object({ value: z.string() }), z.object({ value: z.string().optional() }))
    ).toBe(false);
    expect(schemasMatch(z.string().regex(/abc/), z.string().regex(/abc/i))).toBe(false);
  });

  test('preserves semantically significant union option order', () => {
    const AlphaBranch = z.object({ alpha: z.string() });
    const BetaBranch = z.object({ beta: z.string() });
    const alphaFirst = z.union([AlphaBranch, BetaBranch]);
    const betaFirst = z.union([BetaBranch, AlphaBranch]);
    const overlappingInput = { alpha: 'alpha', beta: 'beta' };
    const definitionHashFor = <Schema extends z.ZodType>(schema: Schema) =>
      createWorkflowRegistry().register({
        current: workflow({
          compatibilityId: 'ordered-union-v1',
          configSchema: TEST_CONFIG_SCHEMA,
          executionDefaults: TEST_EXECUTION_DEFAULTS,
          id: 'ordered-union',
          inputSchema: schema,
          outputSchema: schema,
          root: step({
            id: 'identity',
            inputSchema: schema,
            outputSchema: schema,
            run: async ({ input }) => input,
          }),
        }),
      }).current.definitionHash;

    expect(alphaFirst.parse(overlappingInput)).toEqual({ alpha: 'alpha' });
    expect(betaFirst.parse(overlappingInput)).toEqual({ beta: 'beta' });
    expect(schemasMatch(alphaFirst, betaFirst)).toBe(false);
    expect(definitionHashFor(alphaFirst)).not.toBe(definitionHashFor(betaFirst));
  });

  test('produces the same canonical order on every host locale', () => {
    expect(canonicalJson({ z: 1, A: 2, a: 3, à: 4 })).toBe('{"A":2,"a":3,"z":1,"à":4}');
  });

  test.each([
    ['coerce', z.coerce.string()],
    ['overwrite', z.string().trim()],
    ['super refinement', z.string().superRefine(() => undefined)],
  ])('rejects lossy %s semantics in a durable schema', (_name, unsupportedSchema) => {
    expect(() => durableSchemaShape(unsupportedSchema)).toThrow(/Unsupported durable schema/);
  });

  test('rejects duplicate node ids at registration', () => {
    const duplicate = step({
      id: 'same',
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      run: async ({ input }) => input,
    });
    const definition = workflow({
      compatibilityId: 'duplicates-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      id: 'duplicates',
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      inputSchema: LessonInput,
      outputSchema: LessonInput,
      root: sequence({ id: 'root', nodes: [duplicate, duplicate] }),
    });

    expect(() => createWorkflowRegistry().register({ current: definition })).toThrow(
      'Duplicate workflow node id: same'
    );
  });

  test.each([
    ['transform', z.string().transform(value => value.trim())],
    ['preprocess', z.preprocess(value => value, z.string())],
    ['catch', z.string().catch('fallback')],
    ['custom refinement', z.string().refine(value => value.length > 0)],
  ])('rejects %s in a durable schema', (_name, unsupportedSchema) => {
    const invalid = workflow({
      compatibilityId: 'invalid-schema-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      id: 'invalid-schema',
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      inputSchema: unsupportedSchema,
      outputSchema: z.string(),
      root: step({
        id: 'invalid',
        inputSchema: unsupportedSchema,
        outputSchema: z.string(),
        run: async ({ input }) => input,
      }),
    });

    expect(() => createWorkflowRegistry().register({ current: invalid })).toThrow(
      /Unsupported durable schema/
    );
  });

  test('rejects a durable boundary that can produce an undefined JSON value', () => {
    const OptionalText = z.string().optional();
    const invalid = workflow({
      compatibilityId: 'undefined-boundary-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      id: 'undefined-boundary',
      inputSchema: OptionalText,
      outputSchema: OptionalText,
      root: step({
        id: 'optional-step',
        inputSchema: OptionalText,
        outputSchema: OptionalText,
        run: async ({ input }) => input,
      }),
    });

    expect(() => createWorkflowRegistry().register({ current: invalid })).toThrow(
      'Unsupported durable schema at workflow.input: optional values are only allowed as object properties'
    );
  });

  test('rejects undefined array entries that JSON would silently turn into null', () => {
    expect(() => durableSchemaShape(z.array(z.string().optional()))).toThrow(
      'Unsupported durable schema at schema.element: optional values are only allowed as object properties'
    );
  });

  test('rejects unknown signals and events', () => {
    const missingSignal = workflow({
      compatibilityId: 'missing-signal-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      id: 'missing-signal',
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      inputSchema: LessonDraft,
      outputSchema: LessonDraft,
      root: waitForSignal({
        id: 'approval',
        inputSchema: LessonDraft,
        outputSchema: LessonDraft,
        payloadSchema: ApprovalSignal,
        signal: 'notDeclared',
        resume: input => input,
      }),
    });
    const missingEvent = workflow({
      compatibilityId: 'missing-event-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      id: 'missing-event',
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      inputSchema: LessonDraft,
      outputSchema: LessonDraft,
      root: emit({
        id: 'announce',
        event: 'notDeclared',
        inputSchema: LessonDraft,
        payload: () => ({}),
      }),
    });

    expect(() => createWorkflowRegistry().register({ current: missingSignal })).toThrow(
      'Unknown signal "notDeclared" in node approval'
    );
    expect(() => createWorkflowRegistry().register({ current: missingEvent })).toThrow(
      'Unknown event "notDeclared" in node announce'
    );
  });

  test('does not treat inherited object properties as declared signals or events', () => {
    const inheritedEvent = workflow({
      compatibilityId: 'inherited-event-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      id: 'inherited-event',
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      inputSchema: LessonDraft,
      outputSchema: LessonDraft,
      root: emit({
        id: 'announce',
        event: 'toString',
        inputSchema: LessonDraft,
        payload: () => ({}),
      }),
    });
    const inheritedSignal = workflow({
      compatibilityId: 'inherited-signal-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      id: 'inherited-signal',
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      inputSchema: LessonDraft,
      outputSchema: LessonDraft,
      root: waitForSignal({
        id: 'approval',
        inputSchema: LessonDraft,
        outputSchema: LessonDraft,
        payloadSchema: ApprovalSignal,
        signal: 'constructor',
        resume: input => input,
      }),
    });

    expect(() => createWorkflowRegistry().register({ current: inheritedEvent })).toThrow(
      'Unknown event "toString" in node announce'
    );
    expect(() => createWorkflowRegistry().register({ current: inheritedSignal })).toThrow(
      'Unknown signal "constructor" in node approval'
    );
  });

  test('rejects invalid signal versions and wait payload schemas', () => {
    const invalidVersion = makeLessonWorkflow({});
    const mismatchedWait = workflow({
      compatibilityId: 'mismatched-signal-schema-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      id: 'mismatched-signal-schema',
      inputSchema: LessonDraft,
      outputSchema: LessonDraft,
      root: waitForSignal({
        id: 'approval',
        inputSchema: LessonDraft,
        outputSchema: LessonDraft,
        payloadSchema: z.object({ rejected: z.literal(true) }),
        resume: input => input,
        signal: 'approveDraft',
      }),
      signals: { approveDraft: { schema: ApprovalSignal, schemaVersion: 1 } },
    });

    expect(() =>
      createWorkflowRegistry().register({
        current: {
          ...invalidVersion,
          signals: { approveDraft: { schema: ApprovalSignal, schemaVersion: 0 } },
        },
      })
    ).toThrow('signals.approveDraft.schemaVersion must be a positive PostgreSQL integer.');
    expect(() => createWorkflowRegistry().register({ current: mismatchedWait })).toThrow(
      'Signal wait approval has an incompatible payload schema.'
    );
  });

  test('rejects disconnected sequence schemas', () => {
    const definition = workflow({
      compatibilityId: 'disconnected-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      id: 'disconnected',
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      inputSchema: LessonInput,
      outputSchema: z.string(),
      root: sequence({
        id: 'root',
        nodes: [
          step({
            id: 'first',
            inputSchema: LessonInput,
            outputSchema: LessonDraft,
            run: async ({ input }) => ({ ...input, content: 'draft' }),
          }),
          step({
            id: 'second',
            inputSchema: z.string(),
            outputSchema: z.string(),
            run: async ({ input }) => input,
          }),
        ],
      }),
    });

    expect(() => createWorkflowRegistry().register({ current: definition })).toThrow(
      'Sequence root connects incompatible schemas between first and second'
    );
  });

  test('validates manually constructed sequence boundaries and rejects empty sequences', () => {
    const numberStep = step({
      id: 'number-step',
      inputSchema: z.number(),
      outputSchema: z.number(),
      run: async ({ input }) => input,
    });
    const mismatchedRoot: SequenceDefinition<string, string> = {
      id: 'root',
      inputSchema: z.string(),
      kind: 'sequence',
      nodes: [numberStep],
      outputSchema: z.string(),
    };
    const emptyRoot: SequenceDefinition<string, string> = {
      id: 'root',
      inputSchema: z.string(),
      kind: 'sequence',
      nodes: [],
      outputSchema: z.string(),
    };

    expect(() =>
      createWorkflowRegistry().register({
        current: workflow({
          compatibilityId: 'mismatched-sequence-v1',
          configSchema: TEST_CONFIG_SCHEMA,
          id: 'mismatched-sequence',
          executionDefaults: TEST_EXECUTION_DEFAULTS,
          inputSchema: z.string(),
          outputSchema: z.string(),
          root: mismatchedRoot,
        }),
      })
    ).toThrow('Sequence root has an incompatible input schema.');
    expect(() =>
      createWorkflowRegistry().register({
        current: workflow({
          compatibilityId: 'empty-sequence-v1',
          configSchema: TEST_CONFIG_SCHEMA,
          id: 'empty-sequence',
          executionDefaults: TEST_EXECUTION_DEFAULTS,
          inputSchema: z.string(),
          outputSchema: z.string(),
          root: emptyRoot,
        }),
      })
    ).toThrow('Sequence root must contain at least one node.');
  });

  test('rejects an empty compatibility id instead of hashing it as absent', () => {
    expect(() =>
      createWorkflowRegistry().register({
        current: makeLessonWorkflow({ compatibilityId: '', waitForApproval: false }),
      })
    ).toThrow('compatibilityId is required.');
  });

  test.each([
    [
      'unknown node kind',
      {
        id: 'mystery',
        inputSchema: z.string(),
        kind: 'mystery',
        outputSchema: z.string(),
      },
      'Unknown workflow node kind "mystery" at root.mystery.',
    ],
    [
      'step without a run callback',
      {
        id: 'incomplete-step',
        inputSchema: z.string(),
        kind: 'step',
        outputSchema: z.string(),
      },
      'Step incomplete-step must define a run callback.',
    ],
  ])('rejects a manually constructed %s', (_name, invalidRoot, expectedMessage) => {
    const invalidDefinition = workflow({
      compatibilityId: 'invalid-node-shape-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: TEST_EXECUTION_DEFAULTS,
      id: 'invalid-node-shape',
      inputSchema: z.string(),
      outputSchema: z.string(),
      root: invalidRoot as unknown as WorkflowNode<
        string,
        string,
        z.output<typeof TEST_CONFIG_SCHEMA>,
        unknown
      >,
    });

    expect(() => createWorkflowRegistry().register({ current: invalidDefinition })).toThrow(
      expectedMessage
    );
  });

  test('snapshots the executable definition before storing its structural hash', () => {
    const mutableConfig = { timeoutMs: 30_000 };
    const first = step({
      config: mutableConfig,
      id: 'first',
      inputSchema: z.string(),
      outputSchema: z.string(),
      run: async ({ input }) => input,
    });
    const second = step({
      id: 'second',
      inputSchema: z.string(),
      outputSchema: z.string(),
      run: async ({ input }) => input,
    });
    const mutableNodes: [typeof first, ...(typeof first)[]] = [first];
    const mutableDefaults = { maxAttempts: 3, timeoutMs: 60_000 };
    const definition = workflow({
      compatibilityId: 'immutable-registration-v1',
      configSchema: TEST_CONFIG_SCHEMA,
      executionDefaults: mutableDefaults,
      id: 'immutable-registration',
      inputSchema: z.string(),
      outputSchema: z.string(),
      root: sequence({ id: 'root', nodes: mutableNodes }),
    });
    const registered = createWorkflowRegistry().register({ current: definition }).current;
    const originalHash = registered.definitionHash;

    mutableNodes.push(second);
    mutableDefaults.timeoutMs = 1;
    mutableConfig.timeoutMs = 1;

    expect((registered.root as SequenceDefinition).nodes.map(node => node.id)).toEqual(['first']);
    expect(registered.executionDefaults.timeoutMs).toBe(60_000);
    expect((registered.root as SequenceDefinition).nodes[0]).toMatchObject({
      config: { timeoutMs: 30_000 },
    });
    expect(
      Object.isFrozen(
        (registered.root as SequenceDefinition).nodes[0]?.config as Record<string, unknown>
      )
    ).toBe(true);
    expect(registered.definitionHash).toBe(originalHash);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen((registered.root as SequenceDefinition).nodes)).toBe(true);
  });

  test('validates fan-out and repeat contracts even for manually constructed nodes', () => {
    const worker = step({
      id: 'worker',
      inputSchema: z.number(),
      outputSchema: z.number(),
      run: async ({ input }) => input,
    });
    const invalidFanOut = {
      failureMode: 'sometimes',
      fanIn: () => '',
      id: 'fan-out',
      inputSchema: z.array(z.string()),
      inputs: (input: string[]) => input,
      itemSchema: z.string(),
      keyBy: (input: string) => input,
      kind: 'fanOut' as const,
      outputSchema: z.string(),
      worker,
    };
    const invalidRepeat = {
      body: worker,
      id: 'loop',
      inputSchema: z.string(),
      kind: 'repeat' as const,
      maxIterations: 0,
      onExhausted: (state: string) => state,
      outputSchema: z.string(),
    };

    expect(() =>
      createWorkflowRegistry().register({
        current: workflow({
          compatibilityId: 'invalid-fan-out-v1',
          configSchema: TEST_CONFIG_SCHEMA,
          executionDefaults: TEST_EXECUTION_DEFAULTS,
          id: 'invalid-fan-out',
          inputSchema: invalidFanOut.inputSchema,
          outputSchema: invalidFanOut.outputSchema,
          root: invalidFanOut as unknown as WorkflowNode<
            string[],
            string,
            z.output<typeof TEST_CONFIG_SCHEMA>,
            unknown
          >,
        }),
      })
    ).toThrow('Fan-out fan-out has an unknown failure mode.');
    expect(() =>
      createWorkflowRegistry().register({
        current: workflow({
          compatibilityId: 'invalid-repeat-v1',
          configSchema: TEST_CONFIG_SCHEMA,
          executionDefaults: TEST_EXECUTION_DEFAULTS,
          id: 'invalid-repeat',
          inputSchema: invalidRepeat.inputSchema,
          outputSchema: invalidRepeat.outputSchema,
          root: invalidRepeat,
        }),
      })
    ).toThrow('root.loop.maxIterations must be a positive integer.');
  });
});
