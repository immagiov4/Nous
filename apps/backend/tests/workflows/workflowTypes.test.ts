import { expectTypeOf, test } from 'vitest';
import * as z from 'zod';

import { unset, WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import { emit, sequence, step, workflow } from '../../src/workflows/definition.js';
import type {
  SequenceDefinition,
  StepCommitContext,
  StepExecutionContext,
  StepUndoContext,
  WorkflowExecutionDefaults,
} from '../../src/workflows/types.js';

interface CustomConfig extends WorkflowExecutionDefaults {
  mode: 'careful';
  provider: {
    apiKey?: string;
    speed: 'normal' | 'fast';
  };
  tags: string[];
}

interface WorkflowServices {
  save: (value: number) => Promise<void>;
}

interface OtherServices {
  notify: (value: number) => Promise<void>;
}

const CustomConfigSchema = WorkflowExecutionDefaultsSchema.extend({
  mode: z.literal('careful'),
  provider: z.object({ apiKey: z.string().optional(), speed: z.enum(['normal', 'fast']) }),
  tags: z.array(z.string()),
});
const Text = z.string();
const Count = z.number();

const parseCount = step<typeof Text, typeof Count, CustomConfig, WorkflowServices>({
  config: {
    provider: { apiKey: unset(), speed: 'fast' },
    tags: ['parse'],
  },
  id: 'parse-count',
  inputSchema: Text,
  outputSchema: Count,
  run: async ({ input }: StepExecutionContext<string, CustomConfig, WorkflowServices>) =>
    Number.parseInt(input, 10),
});
const persistCount = step<typeof Count, typeof Count, CustomConfig, WorkflowServices>({
  id: 'persist-count',
  inputSchema: Count,
  outputSchema: Count,
  run: async ({ input, services }) => {
    await services.save(input);
    return input;
  },
});
const announceInput = emit({
  event: 'inputSeen',
  id: 'announce-input',
  inputSchema: Text,
  payload: input => input,
});
const composed = sequence({ id: 'root', nodes: [announceInput, parseCount, persistCount] });
const parseWorkflow = workflow({
  configSchema: CustomConfigSchema,
  executionDefaults: {
    maxAttempts: 3,
    mode: 'careful',
    provider: { apiKey: 'secret', speed: 'normal' },
    tags: ['default'],
    timeoutMs: 60_000,
  },
  id: 'parse-workflow',
  inputSchema: Text,
  outputSchema: Count,
  root: parseCount,
});
const composedWithWorkflow = sequence({
  id: 'workflow-root',
  nodes: [announceInput, parseWorkflow, persistCount],
});

test('sequence preserves workflow config and services types', () => {
  expectTypeOf(composed).toEqualTypeOf<
    SequenceDefinition<string, number, CustomConfig, WorkflowServices>
  >();
  expectTypeOf(composedWithWorkflow).toEqualTypeOf<
    SequenceDefinition<string, number, CustomConfig, WorkflowServices>
  >();
});

const verifyRejectedCompositions = (): void => {
  const incompatibleServiceStep = step<typeof Count, typeof Count, CustomConfig, OtherServices>({
    id: 'notify-count',
    inputSchema: Count,
    outputSchema: Count,
    run: async ({ input, services }) => {
      await services.notify(input);
      return input;
    },
  });

  // @ts-expect-error A sequence has one shared Config and Services context.
  sequence({ id: 'mixed-services', nodes: [parseCount, incompatibleServiceStep] });

  const wrongRoot = step<typeof Count, typeof Count, CustomConfig, WorkflowServices>({
    id: 'wrong-root',
    inputSchema: Count,
    outputSchema: Count,
    run: async ({ input }) => input,
  });

  workflow({
    configSchema: CustomConfigSchema,
    executionDefaults: {
      maxAttempts: 3,
      mode: 'careful',
      provider: { speed: 'normal' },
      tags: [],
      timeoutMs: 60_000,
    },
    id: 'wrong-boundary',
    inputSchema: Text,
    outputSchema: Text,
    // @ts-expect-error Workflow root schemas must exactly match the declared workflow boundaries.
    root: wrongRoot,
  });

  step<typeof Text, typeof Count, CustomConfig, WorkflowServices>({
    // @ts-expect-error Step configuration overrides retain the workflow configuration type.
    config: { provider: { speed: 'turbo' } },
    id: 'invalid-config-override',
    inputSchema: Text,
    outputSchema: Count,
    run: async () => 1,
  });
};

const verifyDeepReadonlyStepConfig = (
  run: StepExecutionContext<string, CustomConfig, WorkflowServices>,
  commit: StepCommitContext<string, number, CustomConfig, WorkflowServices>,
  undo: StepUndoContext<string, number, CustomConfig, WorkflowServices>
): void => {
  // @ts-expect-error Runtime configuration snapshots are recursively immutable.
  run.config.provider.speed = 'fast';
  // @ts-expect-error Runtime configuration arrays are recursively immutable.
  run.config.tags.push('mutated');
  // @ts-expect-error Commit receives the same recursively immutable configuration.
  commit.config.provider.apiKey = 'changed';
  // @ts-expect-error Undo receives the same recursively immutable configuration.
  undo.config.tags[0] = 'changed';
};

void verifyRejectedCompositions;
void verifyDeepReadonlyStepConfig;
